// B.3.1 — Provider registry tests (pure, no DB, no network)

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getPaymentProvider,
  getShippingProvider,
  getInvoiceProvider,
  getProvider,
  listProviders,
  assertCapability,
  isPaymentProviderId,
  isShippingProviderId,
  isInvoiceProviderId,
  PAYMENT_PROVIDERS,
  SHIPPING_PROVIDERS,
  INVOICE_PROVIDERS,
} from "@/lib/providers/registry";
import { ProviderError } from "@/lib/providers/errors";

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).code).toBe(code);
  }
}

describe("B.3.1 — provider registry: allowlists", () => {
  it("allowlists exactly the selected future providers", () => {
    expect([...PAYMENT_PROVIDERS]).toEqual(["eupago"]);
    expect([...SHIPPING_PROVIDERS]).toEqual(["mrw", "ctt"]);
    expect([...INVOICE_PROVIDERS]).toEqual(["xd"]);
  });

  it("resolves eupago as an external payment provider", () => {
    const p = getPaymentProvider("eupago");
    expect(p.id).toBe("eupago");
    expect(p.kind).toBe("payment");
    expect(p.external).toBe(true);
    expect(p.supports("createPayment")).toBe(true);
    expect(p.supports("handleWebhook")).toBe(true);
  });

  it("resolves mrw and ctt as shipping providers", () => {
    const mrw = getShippingProvider("mrw");
    const ctt = getShippingProvider("ctt");
    expect(mrw.kind).toBe("shipping");
    expect(ctt.kind).toBe("shipping");
    expect(mrw.supports("createShipment")).toBe(true);
    expect(ctt.supports("createShipment")).toBe(true);
    expect(mrw.supports("getTracking")).toBe(true);
    expect(ctt.supports("getTracking")).toBe(true);
  });

  it("resolves xd as the invoice provider", () => {
    const xd = getInvoiceProvider("xd");
    expect(xd.id).toBe("xd");
    expect(xd.kind).toBe("invoice");
    expect(xd.supports("createInvoice")).toBe(true);
    expect(xd.supports("createCreditNote")).toBe(true);
  });

  it("resolves any allowlisted provider through getProvider", () => {
    expect(getProvider("eupago").kind).toBe("payment");
    expect(getProvider("ctt").kind).toBe("shipping");
    expect(getProvider("xd").kind).toBe("invoice");
    expect(listProviders().map((p) => p.id).sort()).toEqual(["ctt", "eupago", "mrw", "xd"]);
    expect(listProviders("shipping").map((p) => p.id)).toEqual(["mrw", "ctt"]);
  });
});

describe("B.3.1 — provider registry: unsupported providers", () => {
  it("rejects unknown providers with UNSUPPORTED_PROVIDER", () => {
    expectCode(() => getPaymentProvider("stripe"), "UNSUPPORTED_PROVIDER");
    expectCode(() => getShippingProvider("dhl"), "UNSUPPORTED_PROVIDER");
    expectCode(() => getInvoiceProvider("moloni"), "UNSUPPORTED_PROVIDER");
    expectCode(() => getProvider("unknown"), "UNSUPPORTED_PROVIDER");
  });

  it("does not accept a provider of the wrong kind", () => {
    expectCode(() => getPaymentProvider("mrw"), "UNSUPPORTED_PROVIDER");
    expectCode(() => getShippingProvider("eupago"), "UNSUPPORTED_PROVIDER");
    expectCode(() => getInvoiceProvider("ctt"), "UNSUPPORTED_PROVIDER");
  });

  it("does not accept the internal methods as external providers", () => {
    // bank_transfer and store pickup stay internal and independent
    expectCode(() => getPaymentProvider("bank_transfer"), "UNSUPPORTED_PROVIDER");
    expectCode(() => getShippingProvider("store_pickup"), "UNSUPPORTED_PROVIDER");
    expectCode(() => getShippingProvider("pickup"), "UNSUPPORTED_PROVIDER");
  });

  it("exposes type guards consistent with the allowlists", () => {
    expect(isPaymentProviderId("eupago")).toBe(true);
    expect(isPaymentProviderId("bank_transfer")).toBe(false);
    expect(isShippingProviderId("ctt")).toBe(true);
    expect(isShippingProviderId("pickup")).toBe(false);
    expect(isInvoiceProviderId("xd")).toBe(true);
    expect(isInvoiceProviderId("xdsoftware")).toBe(false);
  });
});

describe("B.3.1 — provider registry: capabilities", () => {
  it("passes assertCapability for supported operations", () => {
    expect(() => assertCapability(getShippingProvider("mrw"), "createShipment")).not.toThrow();
    expect(() => assertCapability(getInvoiceProvider("xd"), "createCreditNote")).not.toThrow();
    expect(() => assertCapability(getPaymentProvider("eupago"), "refundPayment")).not.toThrow();
  });

  it("throws OPERATION_NOT_SUPPORTED for unsupported operations", () => {
    // CTT has no cancelShipment adapter capability in this foundation
    expectCode(() => assertCapability(getShippingProvider("ctt"), "cancelShipment"), "OPERATION_NOT_SUPPORTED");
    expectCode(() => assertCapability(getPaymentProvider("eupago"), "createShipment"), "OPERATION_NOT_SUPPORTED");
    expectCode(() => assertCapability(getInvoiceProvider("xd"), "quote"), "OPERATION_NOT_SUPPORTED");
  });
});

describe("B.3.1 — provider registry: no network", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never performs fetch during registry resolution", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    getPaymentProvider("eupago");
    getShippingProvider("mrw");
    getShippingProvider("ctt");
    getInvoiceProvider("xd");
    listProviders();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
