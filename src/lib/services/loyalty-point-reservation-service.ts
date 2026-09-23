import { loyaltyPointMovements, loyaltyPointReservations, orders, users } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/stock-locks";
import { LOYALTY_POINTS_PER_REDEMPTION_EURO } from "@/lib/services/loyalty-service";

function assertPoints(points: number) {
  if (!Number.isInteger(points) || points < LOYALTY_POINTS_PER_REDEMPTION_EURO || points % LOYALTY_POINTS_PER_REDEMPTION_EURO !== 0) {
    throw new Error("VALIDATION:Os pontos devem ser um múltiplo inteiro de 100");
  }
}

export async function getAvailableLoyaltyPointsTx(tx: DbOrTx, userId: number, lockUser = false) {
  if (lockUser) await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("VALIDATION:Cliente não encontrado");
  const [ledger] = await tx.select({ points: sql<number>`COALESCE(SUM(${loyaltyPointMovements.pointsDelta}), 0)::int` }).from(loyaltyPointMovements).where(eq(loyaltyPointMovements.userId, userId));
  const [reserved] = await tx.select({ points: sql<number>`COALESCE(SUM(${loyaltyPointReservations.points}), 0)::int` }).from(loyaltyPointReservations).where(and(eq(loyaltyPointReservations.userId, userId), eq(loyaltyPointReservations.status, "reserved")));
  return Math.max(0, Number(ledger?.points ?? 0) - Number(reserved?.points ?? 0));
}

export async function reserveLoyaltyPointsForOrderTx(tx: DbOrTx, userId: number, orderId: number, points: number) {
  assertPoints(points);
  const [order] = await tx.select({ id: orders.id, userId: orders.userId, status: orders.status }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.userId !== userId || order.status !== "pending_payment") throw new Error("VALIDATION:Encomenda inválida para utilização de pontos");
  const available = await getAvailableLoyaltyPointsTx(tx, userId, true);
  if (available < points) throw new Error("VALIDATION:Saldo de pontos insuficiente");
  const [reservation] = await tx.insert(loyaltyPointReservations).values({ userId, orderId, points, valueCents: points, status: "reserved" }).returning();
  return reservation;
}

export async function consumeLoyaltyPointsForOrderTx(tx: DbOrTx, orderId: number, actorUserId: number | null) {
  const [order] = await tx.select({ id: orders.id, userId: orders.userId, paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.paymentStatus !== "paid") throw new Error("VALIDATION:Os pontos só podem ser consumidos após pagamento confirmado");
  await tx.execute(sql`SELECT id FROM loyalty_point_reservations WHERE order_id = ${orderId} FOR UPDATE`);
  const [reservation] = await tx.select().from(loyaltyPointReservations).where(and(eq(loyaltyPointReservations.orderId, orderId), eq(loyaltyPointReservations.status, "reserved"))).limit(1);
  if (!reservation) return { changed: false };
  if (order.userId !== reservation.userId) throw new Error("LOYALTY_INCONSISTENCY: reserva pertence a outro cliente");
  const idempotencyKey = `order:${orderId}:loyalty:redeem`;
  const [insertedMovement] = await tx.insert(loyaltyPointMovements).values({
    userId: reservation.userId, orderId, type: "redeem", pointsDelta: -reservation.points, eligibleAmountCents: null,
    idempotencyKey, reason: `Utilização direta de ${reservation.points} pontos na encomenda`, actorUserId,
  }).onConflictDoNothing({ target: loyaltyPointMovements.idempotencyKey }).returning({ id: loyaltyPointMovements.id });

  if (!insertedMovement) {
    const [existingMovement] = await tx.select({
      userId: loyaltyPointMovements.userId, orderId: loyaltyPointMovements.orderId,
      type: loyaltyPointMovements.type, pointsDelta: loyaltyPointMovements.pointsDelta,
    }).from(loyaltyPointMovements).where(eq(loyaltyPointMovements.idempotencyKey, idempotencyKey)).limit(1);
    if (!existingMovement || existingMovement.userId !== reservation.userId || existingMovement.orderId !== orderId || existingMovement.type !== "redeem" || existingMovement.pointsDelta !== -reservation.points) {
      throw new Error("LOYALTY_INCONSISTENCY: movimento de débito idempotente não corresponde à reserva");
    }
  }

  const [updated] = await tx.update(loyaltyPointReservations).set({ status: "used", consumedAt: new Date(), updatedAt: new Date() }).where(and(eq(loyaltyPointReservations.id, reservation.id), eq(loyaltyPointReservations.status, "reserved"))).returning({ id: loyaltyPointReservations.id });
  if (!updated) throw new Error("LOYALTY_INCONSISTENCY: reserva de pontos não pôde ser consumida");
  return { changed: true };
}

export async function releaseLoyaltyPointsForOrderTx(tx: DbOrTx, orderId: number) {
  return tx.update(loyaltyPointReservations).set({ status: "released", releasedAt: new Date(), updatedAt: new Date() }).where(and(eq(loyaltyPointReservations.orderId, orderId), eq(loyaltyPointReservations.status, "reserved"))).returning({ id: loyaltyPointReservations.id });
}
