import { db } from "@/db";
import { products, settings, shippingClasses, type DeliveryType } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { toEuros } from "@/lib/money";

export const DEFAULT_SHIPPING_CLASSES = [
  { key: "small", displayName: "Pequeno", rateCents: 490, priority: 10, isActive: true },
  { key: "large", displayName: "Grande", rateCents: 790, priority: 20, isActive: true },
] as const;

export const DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS = 10_000;

type QueryDb = typeof db;

export interface ShippingClassRecord {
  id: number;
  key: string;
  displayName: string;
  rateCents: number;
  priority: number;
  isActive: boolean;
  notes: string | null;
}

export interface CartShippingItem {
  productId: number;
  quantity: number;
}

export interface ShippingCalculationResult {
  deliveryType: DeliveryType;
  shippingCents: number;
  shippingEuros: string;
  freeShippingApplied: boolean;
  freeShippingThresholdEnabled: boolean;
  freeShippingThresholdCents: number;
  freeShippingThresholdEuros: string;
  thresholdBasisCents: number;
  winningClass: ShippingClassRecord | null;
}

export class ShippingRateError extends Error {
  constructor(readonly code: "SHIPPING_CLASS_MISSING" | "SHIPPING_CLASS_INACTIVE" | "SHIPPING_CLASS_INVALID" | "INVALID_DELIVERY_TYPE", message: string) {
    super(message);
    this.name = "ShippingRateError";
  }
}

export function parseCentsSetting(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^\d+(?:\.\d{1,2})?$/.test(value)) {
    const [euros, cents = ""] = value.split(".");
    return Number(euros) * 100 + Number(cents.padEnd(2, "0"));
  }
  return fallback;
}

export async function ensureDefaultShippingConfiguration(database: QueryDb = db): Promise<void> {
  for (const cls of DEFAULT_SHIPPING_CLASSES) {
    await database.insert(shippingClasses).values(cls).onConflictDoNothing();
  }
  await database.insert(settings).values([
    { key: "shipping_free_threshold_enabled", value: "true", group: "shipping" },
    { key: "shipping_free_threshold_cents", value: String(DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS), group: "shipping" },
    { key: "invoice_mode", value: "manual", group: "invoicing" },
  ]).onConflictDoNothing();
}

export async function listShippingClasses(includeInactive = false): Promise<ShippingClassRecord[]> {
  await ensureDefaultShippingConfiguration();
  const where = includeInactive ? undefined : eq(shippingClasses.isActive, true);
  return db.select().from(shippingClasses).where(where).orderBy(shippingClasses.priority, shippingClasses.displayName);
}

export async function updateShippingClass(input: {
  id: number;
  displayName: string;
  rateCents: number;
  priority: number;
  isActive: boolean;
  notes?: string | null;
}): Promise<ShippingClassRecord> {
  if (!input.displayName.trim()) throw new Error("INVALID_DISPLAY_NAME");
  if (!Number.isInteger(input.rateCents) || input.rateCents < 0) throw new Error("INVALID_RATE");
  if (!Number.isInteger(input.priority) || input.priority < 0) throw new Error("INVALID_PRIORITY");
  const [row] = await db.update(shippingClasses).set({
    displayName: input.displayName.trim(),
    rateCents: input.rateCents,
    priority: input.priority,
    isActive: input.isActive,
    notes: input.notes?.trim() || null,
    updatedAt: new Date(),
  }).where(eq(shippingClasses.id, input.id)).returning();
  if (!row) throw new Error("SHIPPING_CLASS_NOT_FOUND");
  return row;
}

export async function getFreeShippingSettings(database: QueryDb = db): Promise<{ enabled: boolean; thresholdCents: number }> {
  await ensureDefaultShippingConfiguration(database);
  const rows = await database.select().from(settings).where(inArray(settings.key, ["shipping_free_threshold_enabled", "shipping_free_threshold_cents"]));
  const map = new Map(rows.map((s) => [s.key, s.value]));
  return {
    enabled: map.get("shipping_free_threshold_enabled") !== "false",
    thresholdCents: parseCentsSetting(map.get("shipping_free_threshold_cents"), DEFAULT_FREE_SHIPPING_THRESHOLD_CENTS),
  };
}

export async function updateFreeShippingSettings(input: { enabled: boolean; thresholdCents: number }): Promise<void> {
  if (!Number.isInteger(input.thresholdCents) || input.thresholdCents < 0) throw new Error("INVALID_THRESHOLD");
  await ensureDefaultShippingConfiguration();
  await db.update(settings).set({ value: input.enabled ? "true" : "false" }).where(eq(settings.key, "shipping_free_threshold_enabled"));
  await db.update(settings).set({ value: String(input.thresholdCents) }).where(eq(settings.key, "shipping_free_threshold_cents"));
}

export async function calculateShippingForCart(input: {
  items: CartShippingItem[];
  deliveryType: string;
  merchandiseAfterDiscountCents: number;
}, database: QueryDb = db): Promise<ShippingCalculationResult> {
  await ensureDefaultShippingConfiguration(database);
  if (input.deliveryType !== "shipping" && input.deliveryType !== "pickup") {
    throw new ShippingRateError("INVALID_DELIVERY_TYPE", "Método de entrega inválido");
  }

  const free = await getFreeShippingSettings(database);
  if (input.deliveryType === "pickup") {
    return {
      deliveryType: "pickup",
      shippingCents: 0,
      shippingEuros: "0.00",
      freeShippingApplied: false,
      freeShippingThresholdEnabled: free.enabled,
      freeShippingThresholdCents: free.thresholdCents,
      freeShippingThresholdEuros: toEuros(free.thresholdCents),
      thresholdBasisCents: input.merchandiseAfterDiscountCents,
      winningClass: null,
    };
  }

  const ids = [...new Set(input.items.map((i) => i.productId))];
  const rows = await database
    .select({
      id: products.id,
      name: products.name,
      isService: products.isService,
      shippingClassId: products.shippingClassId,
      classId: shippingClasses.id,
      classKey: shippingClasses.key,
      displayName: shippingClasses.displayName,
      rateCents: shippingClasses.rateCents,
      priority: shippingClasses.priority,
      classActive: shippingClasses.isActive,
      notes: shippingClasses.notes,
    })
    .from(products)
    .leftJoin(shippingClasses, eq(products.shippingClassId, shippingClasses.id))
    .where(and(inArray(products.id, ids), eq(products.isActive, true)));

  if (rows.length !== ids.length) {
    throw new ShippingRateError("SHIPPING_CLASS_INVALID", "Carrinho contém produto indisponível para envio");
  }

  let winner: ShippingClassRecord | null = null;
  for (const row of rows) {
    if (row.isService) continue;
    if (!row.shippingClassId || !row.classId) {
      throw new ShippingRateError("SHIPPING_CLASS_MISSING", `Produto sem classe de envio: ${row.name}`);
    }
    if (!row.classActive) {
      throw new ShippingRateError("SHIPPING_CLASS_INACTIVE", `Classe de envio inativa: ${row.displayName}`);
    }
    if (row.rateCents == null || row.priority == null || row.classKey == null || row.displayName == null || row.rateCents < 0 || row.priority < 0) {
      throw new ShippingRateError("SHIPPING_CLASS_INVALID", "Classe de envio inválida");
    }
    const cls: ShippingClassRecord = {
      id: row.classId,
      key: row.classKey,
      displayName: row.displayName,
      rateCents: row.rateCents,
      priority: row.priority,
      isActive: row.classActive,
      notes: row.notes,
    };
    if (!winner || cls.priority > winner.priority || (cls.priority === winner.priority && cls.rateCents > winner.rateCents)) {
      winner = cls;
    }
  }

  const freeShippingApplied = free.enabled && input.merchandiseAfterDiscountCents >= free.thresholdCents;
  const shippingCents = freeShippingApplied ? 0 : (winner?.rateCents ?? 0);
  return {
    deliveryType: "shipping",
    shippingCents,
    shippingEuros: toEuros(shippingCents),
    freeShippingApplied,
    freeShippingThresholdEnabled: free.enabled,
    freeShippingThresholdCents: free.thresholdCents,
    freeShippingThresholdEuros: toEuros(free.thresholdCents),
    thresholdBasisCents: input.merchandiseAfterDiscountCents,
    winningClass: winner,
  };
}

export async function assignSmallClassToUnclassifiedProducts(): Promise<number> {
  await ensureDefaultShippingConfiguration();
  const [small] = await db.select({ id: shippingClasses.id }).from(shippingClasses).where(eq(shippingClasses.key, "small")).limit(1);
  if (!small) return 0;
  const result = await db.update(products).set({ shippingClassId: small.id, updatedAt: new Date() })
    .where(and(sql`${products.shippingClassId} IS NULL`, eq(products.isService, false)))
    .returning({ id: products.id });
  return result.length;
}
