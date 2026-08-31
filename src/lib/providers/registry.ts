/**
 * B.3.1 — Provider registry (allowlist + capabilities).
 *
 * DESIGN DECISION (B.3.1): the allowlist lives in TypeScript, NOT in a
 * database table. There is no runtime/admin-managed provider configuration
 * requirement in B.3.1: providers are selected in code, capabilities are a
 * property of the adapter implementation, and credentials are supplied by
 * environment/secret bindings — never by the database. A `provider_registry`
 * table would only mirror this file while adding migration + drift risk.
 *
 * This module performs NO network calls and contains NO provider endpoints,
 * payload formats, signature algorithms or credentials.
 */

import { ProviderError } from "./errors";

// ─── Provider identifiers (allowlists) ────────────────────

export const PAYMENT_PROVIDERS = ["eupago"] as const;
export const SHIPPING_PROVIDERS = ["mrw", "ctt"] as const;
export const INVOICE_PROVIDERS = ["xd"] as const;

export type PaymentProviderId = (typeof PAYMENT_PROVIDERS)[number];
export type ShippingProviderId = (typeof SHIPPING_PROVIDERS)[number];
export type InvoiceProviderId = (typeof INVOICE_PROVIDERS)[number];
export type ProviderId = PaymentProviderId | ShippingProviderId | InvoiceProviderId;

export type ProviderKind = "payment" | "shipping" | "invoice";

// ─── Capabilities ─────────────────────────────────────────

export const PAYMENT_CAPABILITIES = [
  "createPayment",
  "getPayment",
  "cancelPayment",
  "refundPayment",
  "handleWebhook",
] as const;

export const SHIPPING_CAPABILITIES = [
  "quote",
  "createShipment",
  "getShipment",
  "getLabel",
  "getTracking",
  "cancelShipment",
] as const;

export const INVOICE_CAPABILITIES = [
  "createInvoice",
  "getDocument",
  "createCreditNote",
  "sendDocument",
  "getStatus",
] as const;

export type PaymentCapability = (typeof PAYMENT_CAPABILITIES)[number];
export type ShippingCapability = (typeof SHIPPING_CAPABILITIES)[number];
export type InvoiceCapability = (typeof INVOICE_CAPABILITIES)[number];
export type ProviderCapability = PaymentCapability | ShippingCapability | InvoiceCapability;

// ─── Descriptors ──────────────────────────────────────────

export interface ProviderDescriptor<
  TId extends ProviderId = ProviderId,
  TCapability extends ProviderCapability = ProviderCapability,
> {
  readonly id: TId;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly capabilities: readonly TCapability[];
  /** External provider requiring network integration (never called in B.3.1). */
  readonly external: true;
  supports(capability: string): boolean;
}

function describe<TId extends ProviderId, TCapability extends ProviderCapability>(
  id: TId,
  kind: ProviderKind,
  displayName: string,
  capabilities: readonly TCapability[]
): ProviderDescriptor<TId, TCapability> {
  return {
    id,
    kind,
    displayName,
    capabilities,
    external: true,
    supports(capability: string): boolean {
      return (capabilities as readonly string[]).includes(capability);
    },
  };
}

/** Eupago — future payment provider (Multibanco / MB WAY / Card). */
const EUPAGO = describe<PaymentProviderId, PaymentCapability>("eupago", "payment", "Eupago", [
  "createPayment",
  "getPayment",
  "cancelPayment",
  "refundPayment",
  "handleWebhook",
]);

/** MRW — future carrier. */
const MRW = describe<ShippingProviderId, ShippingCapability>("mrw", "shipping", "MRW", [
  "quote",
  "createShipment",
  "getShipment",
  "getLabel",
  "getTracking",
  "cancelShipment",
]);

/** CTT — future carrier. */
const CTT = describe<ShippingProviderId, ShippingCapability>("ctt", "shipping", "CTT", [
  "quote",
  "createShipment",
  "getShipment",
  "getLabel",
  "getTracking",
]);

/** XD Software — future fiscal document provider. */
const XD = describe<InvoiceProviderId, InvoiceCapability>("xd", "invoice", "XD Software", [
  "createInvoice",
  "getDocument",
  "createCreditNote",
  "sendDocument",
  "getStatus",
]);

const PAYMENT_REGISTRY: Record<PaymentProviderId, ProviderDescriptor<PaymentProviderId, PaymentCapability>> = {
  eupago: EUPAGO,
};
const SHIPPING_REGISTRY: Record<ShippingProviderId, ProviderDescriptor<ShippingProviderId, ShippingCapability>> = {
  mrw: MRW,
  ctt: CTT,
};
const INVOICE_REGISTRY: Record<InvoiceProviderId, ProviderDescriptor<InvoiceProviderId, InvoiceCapability>> = {
  xd: XD,
};

// ─── Lookup ───────────────────────────────────────────────

function unsupported(id: string): never {
  throw new ProviderError("UNSUPPORTED_PROVIDER", {
    internalDetail: `unknown provider: ${String(id).slice(0, 32)}`,
  });
}

export function isPaymentProviderId(id: string): id is PaymentProviderId {
  return (PAYMENT_PROVIDERS as readonly string[]).includes(id);
}
export function isShippingProviderId(id: string): id is ShippingProviderId {
  return (SHIPPING_PROVIDERS as readonly string[]).includes(id);
}
export function isInvoiceProviderId(id: string): id is InvoiceProviderId {
  return (INVOICE_PROVIDERS as readonly string[]).includes(id);
}

export function getPaymentProvider(id: string): ProviderDescriptor<PaymentProviderId, PaymentCapability> {
  if (!isPaymentProviderId(id)) unsupported(id);
  return PAYMENT_REGISTRY[id];
}

export function getShippingProvider(id: string): ProviderDescriptor<ShippingProviderId, ShippingCapability> {
  if (!isShippingProviderId(id)) unsupported(id);
  return SHIPPING_REGISTRY[id];
}

export function getInvoiceProvider(id: string): ProviderDescriptor<InvoiceProviderId, InvoiceCapability> {
  if (!isInvoiceProviderId(id)) unsupported(id);
  return INVOICE_REGISTRY[id];
}

/** Any allowlisted external provider, regardless of kind. */
export function getProvider(id: string): ProviderDescriptor {
  if (isPaymentProviderId(id)) return PAYMENT_REGISTRY[id];
  if (isShippingProviderId(id)) return SHIPPING_REGISTRY[id];
  if (isInvoiceProviderId(id)) return INVOICE_REGISTRY[id];
  return unsupported(id);
}

export function listProviders(kind?: ProviderKind): readonly ProviderDescriptor[] {
  const all: ProviderDescriptor[] = [EUPAGO, MRW, CTT, XD];
  return kind ? all.filter((p) => p.kind === kind) : all;
}

/**
 * Capability-aware guard. Throws OPERATION_NOT_SUPPORTED when the allowlisted
 * provider exists but cannot perform the requested operation
 * (e.g. CTT has no cancelShipment adapter in this foundation).
 */
export function assertCapability(provider: ProviderDescriptor, capability: string): void {
  if (!provider.supports(capability)) {
    throw new ProviderError("OPERATION_NOT_SUPPORTED", {
      provider: provider.id,
      internalDetail: `capability not supported: ${String(capability).slice(0, 32)}`,
    });
  }
}
