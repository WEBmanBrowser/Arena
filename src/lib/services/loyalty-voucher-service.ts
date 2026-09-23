import { db } from "@/db";
import { loyaltyPointMovements, loyaltyVouchers, orders, users } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { LOYALTY_POINTS_PER_REDEMPTION_EURO, redemptionValueCents } from "@/lib/services/loyalty-service";

const VOUCHER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const VOUCHER_RANDOM_CHARS = 12;
const VOUCHER_CREATE_RETRIES = 3;

function randomVoucherCode(): string {
  const bytes = new Uint8Array(VOUCHER_RANDOM_CHARS);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (byte) => VOUCHER_ALPHABET[byte % VOUCHER_ALPHABET.length]);
  return `MDT-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

function assertRedeemablePoints(points: number) {
  if (!Number.isInteger(points) || points < LOYALTY_POINTS_PER_REDEMPTION_EURO || points % LOYALTY_POINTS_PER_REDEMPTION_EURO !== 0) {
    throw new Error("VALIDATION:Os pontos devem ser um múltiplo inteiro de 100");
  }
}

async function lockUserAndBalance(tx: any, userId: number): Promise<number> {
  await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("VALIDATION:Cliente não encontrado");
  const [row] = await tx.select({ balance: sql<number>`COALESCE(SUM(${loyaltyPointMovements.pointsDelta}), 0)::int` })
    .from(loyaltyPointMovements).where(eq(loyaltyPointMovements.userId, userId));
  return Number(row?.balance ?? 0);
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
}

export async function createLoyaltyVoucher(userId: number, points: number, actorUserId: number | null = userId) {
  assertRedeemablePoints(points);
  const valueCents = redemptionValueCents(points);

  for (let attempt = 0; attempt < VOUCHER_CREATE_RETRIES; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const balance = await lockUserAndBalance(tx, userId);
        if (balance < points) throw new Error("VALIDATION:Saldo de pontos insuficiente");

        const [voucher] = await tx.insert(loyaltyVouchers).values({
          userId, code: randomVoucherCode(), points, valueCents, status: "active",
        }).returning();

        await tx.insert(loyaltyPointMovements).values({
          userId, orderId: null, type: "redeem", pointsDelta: -points,
          eligibleAmountCents: null, idempotencyKey: `voucher:${voucher.id}:redeem`,
          reason: `Conversão de ${points} pontos em vale ${voucher.code}`, actorUserId,
        });

        return voucher;
      });
    } catch (error) {
      if (isUniqueViolation(error) && attempt + 1 < VOUCHER_CREATE_RETRIES) continue;
      throw error;
    }
  }
  throw new Error("Não foi possível gerar um código de vale único");
}

export async function listLoyaltyVouchers(userId: number) {
  return db.select().from(loyaltyVouchers).where(eq(loyaltyVouchers.userId, userId));
}

export async function reserveLoyaltyVoucher(code: string, userId: number, orderId: number) {
  const normalized = code.trim().toUpperCase();
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id, userId: orders.userId, status: orders.status })
      .from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order || order.userId !== userId) throw new Error("VALIDATION:Encomenda inválida para este vale");
    if (order.status !== "pending_payment") throw new Error("VALIDATION:O vale só pode ser reservado numa encomenda pendente");

    await tx.execute(sql`SELECT id FROM loyalty_vouchers WHERE code = ${normalized} FOR UPDATE`);
    const [voucher] = await tx.select().from(loyaltyVouchers).where(eq(loyaltyVouchers.code, normalized)).limit(1);
    if (!voucher || voucher.userId !== userId) throw new Error("VALIDATION:Vale inválido");
    if (voucher.status === "reserved" && voucher.reservedOrderId === orderId) return voucher;
    if (voucher.status !== "active") throw new Error("VALIDATION:Vale indisponível ou já utilizado");

    const [updated] = await tx.update(loyaltyVouchers).set({
      status: "reserved", reservedOrderId: orderId, reservedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(loyaltyVouchers.id, voucher.id), eq(loyaltyVouchers.status, "active"))).returning();
    if (!updated) throw new Error("VALIDATION:Vale indisponível (concorrência)");
    return updated;
  });
}

export async function consumeLoyaltyVoucherForOrderTx(tx: any, orderId: number) {
  const [order] = await tx.select({ id: orders.id, paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("VALIDATION:Encomenda não encontrada");
  if (order.paymentStatus !== "paid") throw new Error("VALIDATION:O vale só pode ser consumido após pagamento confirmado");

  await tx.execute(sql`SELECT id FROM loyalty_vouchers WHERE reserved_order_id = ${orderId} FOR UPDATE`);
  const [voucher] = await tx.select().from(loyaltyVouchers)
    .where(and(eq(loyaltyVouchers.reservedOrderId, orderId), eq(loyaltyVouchers.status, "reserved"))).limit(1);

  if (!voucher) return { changed: false, voucher: null };

  const [updated] = await tx.update(loyaltyVouchers).set({
    status: "used", reservedOrderId: null, reservedAt: null, usedOrderId: orderId, usedAt: new Date(), updatedAt: new Date(),
  }).where(and(
    eq(loyaltyVouchers.id, voucher.id),
    eq(loyaltyVouchers.status, "reserved"),
    eq(loyaltyVouchers.reservedOrderId, orderId)
  )).returning();

  return { changed: Boolean(updated), voucher: updated ?? null };
}

export async function consumeLoyaltyVoucherForOrder(orderId: number) {
  return db.transaction((tx) => consumeLoyaltyVoucherForOrderTx(tx, orderId));
}

export async function releaseLoyaltyVoucherReservationForOrderTx(tx: any, orderId: number) {
  return tx.update(loyaltyVouchers).set({
    status: "active", reservedOrderId: null, reservedAt: null, updatedAt: new Date(),
  }).where(and(eq(loyaltyVouchers.reservedOrderId, orderId), eq(loyaltyVouchers.status, "reserved"))).returning({ id: loyaltyVouchers.id });
}

export async function releaseLoyaltyVoucherReservationForOrder(orderId: number) {
  return db.transaction((tx) => releaseLoyaltyVoucherReservationForOrderTx(tx, orderId));
}
