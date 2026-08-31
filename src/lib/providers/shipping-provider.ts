/**
 * B.3.1 — Shipping provider contract + shipment persistence.
 *
 * Allowlisted external carriers: MRW, CTT. NO live calls, NO endpoints,
 * NO carrier SDK.
 *
 * STORE PICKUP IS INTERNAL: `delivery_type = "pickup"` never becomes a
 * shipment and is never routed through a ShippingProvider adapter. The
 * existing `ready_for_pickup` behaviour stays owned by the Phase A
 * centralized order lifecycle; this module never mutates orders.status.
 */

import { db } from "@/db";
import { shipments, SHIPMENT_STATUSES, type ShipmentStatus } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { ProviderError } from "./errors";
import { assertCapability, getShippingProvider, type ShippingProviderId } from "./registry";

export type ShipmentRecord = typeof shipments.$inferSelect;

/** Internal fulfilment type that must never reach a carrier adapter. */
export const INTERNAL_DELIVERY_TYPES = ["pickup"] as const;

export function isStorePickup(deliveryType: string): boolean {
  return (INTERNAL_DELIVERY_TYPES as readonly string[]).includes(deliveryType);
}

/**
 * Guard for callers: store pickup is fulfilled internally, so asking a carrier
 * to handle it is a programming error, reported as a normalized provider error.
 */
export function assertCarrierEligible(deliveryType: string): void {
  if (isStorePickup(deliveryType)) {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      internalDetail: "store pickup is fulfilled internally, not by a carrier",
    });
  }
}

export function isShipmentStatus(value: string): value is ShipmentStatus {
  return (SHIPMENT_STATUSES as readonly string[]).includes(value);
}

// ─── Provider contract (foundation) ───────────────────────

export interface ShippingAddressInput {
  name: string;
  address1: string;
  address2?: string | null;
  city: string;
  postalCode: string;
  country: string;
  phone?: string | null;
}

export interface ShippingQuoteRequest {
  destination: ShippingAddressInput;
  weightGrams: number;
  service?: string;
}

export interface ShippingQuoteResult {
  provider: ShippingProviderId;
  service: string;
  /** Integer cents, EUR. */
  amountCents: number;
  estimatedDays?: number | null;
}

export interface CreateShipmentRequest {
  orderId: number;
  destination: ShippingAddressInput;
  weightGrams: number;
  service?: string;
}

export interface ShipmentProviderResult {
  providerShipmentId: string;
  trackingNumber?: string | null;
  status: ShipmentStatus;
  labelReference?: string | null;
}

/** Contract every future carrier adapter implements. B.3.1 ships none. */
export interface ShippingProviderAdapter {
  readonly provider: ShippingProviderId;
  quote?(request: ShippingQuoteRequest): Promise<ShippingQuoteResult>;
  createShipment(request: CreateShipmentRequest): Promise<ShipmentProviderResult>;
  getShipment(providerShipmentId: string): Promise<ShipmentProviderResult>;
  getLabel?(providerShipmentId: string): Promise<{ labelReference: string }>;
  getTracking?(providerShipmentId: string): Promise<{ trackingNumber: string; status: ShipmentStatus }>;
  cancelShipment?(providerShipmentId: string): Promise<ShipmentProviderResult>;
}

const ADAPTERS = new Map<ShippingProviderId, ShippingProviderAdapter>();

export function registerShippingAdapter(adapter: ShippingProviderAdapter): void {
  getShippingProvider(adapter.provider);
  ADAPTERS.set(adapter.provider, adapter);
}

/**
 * Resolve a carrier adapter, capability-aware.
 * Unknown carrier → UNSUPPORTED_PROVIDER.
 * Known carrier without the capability → OPERATION_NOT_SUPPORTED.
 * Known + capable but no adapter registered (B.3.1) → PROVIDER_UNAVAILABLE.
 */
export function getShippingAdapter(providerId: string, capability?: string): ShippingProviderAdapter {
  const descriptor = getShippingProvider(providerId);
  if (capability) assertCapability(descriptor, capability);
  const adapter = ADAPTERS.get(descriptor.id);
  if (!adapter) {
    throw new ProviderError("PROVIDER_UNAVAILABLE", {
      provider: descriptor.id,
      internalDetail: "no adapter registered in this phase",
    });
  }
  return adapter;
}

// ─── Persistence ──────────────────────────────────────────

export interface CreateShipmentRecordInput {
  orderId: number;
  provider: string;
  service?: string | null;
  providerShipmentId?: string | null;
  trackingNumber?: string | null;
  status?: ShipmentStatus;
  labelReference?: string | null;
  /** Delivery type of the order; "pickup" is rejected. */
  deliveryType?: string;
}

export async function createShipmentRecord(input: CreateShipmentRecordInput): Promise<ShipmentRecord> {
  const descriptor = getShippingProvider(input.provider); // UNSUPPORTED_PROVIDER
  if (input.deliveryType) assertCarrierEligible(input.deliveryType);

  const status = input.status ?? "pending";
  if (!isShipmentStatus(status)) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: descriptor.id,
      internalDetail: "unknown shipment status",
    });
  }

  const [row] = await db
    .insert(shipments)
    .values({
      orderId: input.orderId,
      provider: descriptor.id,
      service: input.service ?? null,
      providerShipmentId: input.providerShipmentId ?? null,
      trackingNumber: input.trackingNumber ?? null,
      status,
      labelReference: input.labelReference ?? null,
    })
    .returning();
  return row;
}

export interface UpdateShipmentInput {
  status?: ShipmentStatus;
  providerShipmentId?: string | null;
  trackingNumber?: string | null;
  labelReference?: string | null;
}

/**
 * Update carrier-side shipment data.
 * Never touches orders.status — order transitions (e.g. → "shipped") remain
 * the responsibility of the centralized Phase A lifecycle.
 */
export async function updateShipment(shipmentId: number, input: UpdateShipmentInput): Promise<ShipmentRecord> {
  const existing = await getShipment(shipmentId);
  if (!existing) throw new ProviderError("SHIPMENT_NOT_FOUND", { internalDetail: `shipment ${shipmentId}` });
  if (input.status && !isShipmentStatus(input.status)) {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
      provider: existing.provider,
      internalDetail: "unknown shipment status",
    });
  }

  const [row] = await db
    .update(shipments)
    .set({
      status: input.status ?? existing.status,
      providerShipmentId: input.providerShipmentId ?? existing.providerShipmentId,
      trackingNumber: input.trackingNumber ?? existing.trackingNumber,
      labelReference: input.labelReference ?? existing.labelReference,
      updatedAt: new Date(),
    })
    .where(eq(shipments.id, shipmentId))
    .returning();
  return row;
}

export async function getShipment(shipmentId: number): Promise<ShipmentRecord | null> {
  const [row] = await db.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
  return row ?? null;
}

export async function listShipmentsForOrder(orderId: number): Promise<ShipmentRecord[]> {
  return db.select().from(shipments).where(eq(shipments.orderId, orderId)).orderBy(shipments.id);
}

export async function findShipmentByProviderId(
  provider: string,
  providerShipmentId: string
): Promise<ShipmentRecord | null> {
  const descriptor = getShippingProvider(provider);
  const [row] = await db
    .select()
    .from(shipments)
    .where(and(eq(shipments.provider, descriptor.id), eq(shipments.providerShipmentId, providerShipmentId)))
    .limit(1);
  return row ?? null;
}
