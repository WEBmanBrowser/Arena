import { db } from "@/db";
import { loyaltyPointMovements, orders, payments, refundAttempts } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { decimalToCents } from "@/lib/money";

export const LOYALTY_POINTS_PER_EURO = 1;
export const LOYALTY_POINTS_PER_REDEMPTION_EURO = 100;

export type LoyaltySummary = {
  balancePoints: number;
  redemptionValueCents: number;
  earnedPoints: number;
  redeemedPoints: number;
  reversedPoints: number;
};

export function pointsForEligibleCents(cents: number): number {
  if (!Number.isInteger(cents) || cents <= 0) return 0;
  return Math.floor(cents / 100) * LOYALTY_POINTS_PER_EURO;
}

export function redemptionValueCents(points: number): number {
  if (!Number.isInteger(points) || points <= 0) return 0;
  return Math.floor(points / LOYALTY_POINTS_PER_REDEMPTION_EURO) * 100;
}

export async function reconcileLoyaltyForOrder(orderId: number, actorUserId: number | null = null) {
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id, userId: orders.userId, total: orders.total }).from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order?.userId) return { changed: false, targetPoints: 0, delta: 0 };

    await tx.execute(sql`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`);

    const [paid] = await tx.select({ cents: sql<number>`COALESCE(SUM(ROUND(${payments.amount}::numeric * 100)), 0)::int` })
      .from(payments).where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")));
    const [refunded] = await tx.select({ cents: sql<number>`COALESCE(SUM(${refundAttempts.amountCents}), 0)::int` })
      .from(refundAttempts).where(and(eq(refundAttempts.orderId, orderId), eq(refundAttempts.status, "succeeded")));
    const paidCents = Math.max(0, Number(paid?.cents ?? 0));
    const orderTotalCents = decimalToCents(order.total) ?? 0;
    const cappedPaidCents = Math.min(paidCents, orderTotalCents);
    const refundedCents = Math.max(0, Number(refunded?.cents ?? 0));
    const eligibleCents = Math.max(0, cappedPaidCents - refundedCents);
    const targetPoints = pointsForEligibleCents(eligibleCents);

    const [existing] = await tx.select({ points: sql<number>`COALESCE(SUM(${loyaltyPointMovements.pointsDelta}), 0)::int` })
      .from(loyaltyPointMovements).where(and(
        eq(loyaltyPointMovements.orderId, orderId),
        inArray(loyaltyPointMovements.type, ["earn", "reverse"]),
      ));
    const currentPoints = Number(existing?.points ?? 0);
    const delta = targetPoints - currentPoints;
    if (delta === 0) return { changed: false, targetPoints, delta: 0 };

    const type = delta > 0 ? "earn" : "reverse";
    const key = `order:${orderId}:loyalty:${type}:target:${targetPoints}`;
    const inserted = await tx.insert(loyaltyPointMovements).values({
      userId: order.userId, orderId, type, pointsDelta: delta,
      eligibleAmountCents: eligibleCents, idempotencyKey: key,
      reason: delta > 0 ? "Pagamento elegível confirmado" : "Reembolso elegível reconciliado",
      actorUserId,
    }).onConflictDoNothing({ target: loyaltyPointMovements.idempotencyKey }).returning({ id: loyaltyPointMovements.id });
    return { changed: inserted.length > 0, targetPoints, delta: inserted.length > 0 ? delta : 0 };
  });
}

export async function getLoyaltySummary(userId: number): Promise<LoyaltySummary> {
  const [row] = await db.select({
    balance: sql<number>`COALESCE(SUM(${loyaltyPointMovements.pointsDelta}), 0)::int`,
    earned: sql<number>`COALESCE(SUM(CASE WHEN ${loyaltyPointMovements.type} = 'earn' THEN ${loyaltyPointMovements.pointsDelta} ELSE 0 END), 0)::int`,
    redeemed: sql<number>`COALESCE(SUM(CASE WHEN ${loyaltyPointMovements.type} = 'redeem' THEN -${loyaltyPointMovements.pointsDelta} ELSE 0 END), 0)::int`,
    reversed: sql<number>`COALESCE(SUM(CASE WHEN ${loyaltyPointMovements.type} = 'reverse' THEN -${loyaltyPointMovements.pointsDelta} ELSE 0 END), 0)::int`,
  }).from(loyaltyPointMovements).where(eq(loyaltyPointMovements.userId, userId));
  const balancePoints = Math.max(0, Number(row?.balance ?? 0));
  return {
    balancePoints,
    redemptionValueCents: redemptionValueCents(balancePoints),
    earnedPoints: Number(row?.earned ?? 0),
    redeemedPoints: Number(row?.redeemed ?? 0),
    reversedPoints: Number(row?.reversed ?? 0),
  };
}
