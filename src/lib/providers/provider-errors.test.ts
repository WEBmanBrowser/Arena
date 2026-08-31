// B.3.1 — Normalized provider error tests (pure, no DB)

import { describe, it, expect } from "vitest";
import {
  ProviderError,
  isProviderError,
  toCustomerSafeError,
  sanitizeErrorMessage,
  PROVIDER_ERROR_CODES,
} from "@/lib/providers/errors";

describe("B.3.1 — provider errors: normalized codes", () => {
  it("exposes the required normalized codes", () => {
    for (const code of [
      "PROVIDER_UNAVAILABLE",
      "INVALID_PROVIDER_RESPONSE",
      "WEBHOOK_INVALID",
      "WEBHOOK_DUPLICATE",
      "PAYMENT_NOT_FOUND",
      "SHIPMENT_NOT_FOUND",
      "INVOICE_NOT_FOUND",
      "OPERATION_NOT_SUPPORTED",
      "UNSUPPORTED_PROVIDER",
    ]) {
      expect(PROVIDER_ERROR_CODES).toContain(code);
    }
  });

  it("builds UNSUPPORTED_PROVIDER errors", () => {
    const e = new ProviderError("UNSUPPORTED_PROVIDER", { provider: "stripe" });
    expect(isProviderError(e)).toBe(true);
    expect(e.code).toBe("UNSUPPORTED_PROVIDER");
    expect(e.retryable).toBe(false);
    expect(e.toCustomerSafeJSON().error).toBe("UNSUPPORTED_PROVIDER");
  });

  it("builds OPERATION_NOT_SUPPORTED errors", () => {
    const e = new ProviderError("OPERATION_NOT_SUPPORTED", { provider: "ctt" });
    expect(e.code).toBe("OPERATION_NOT_SUPPORTED");
    expect(e.retryable).toBe(false);
  });

  it("builds WEBHOOK_DUPLICATE errors", () => {
    const e = new ProviderError("WEBHOOK_DUPLICATE", { provider: "eupago" });
    expect(e.code).toBe("WEBHOOK_DUPLICATE");
    expect(e.toCustomerSafeJSON().message).toMatch(/já recebida/i);
  });

  it("marks PROVIDER_UNAVAILABLE as retryable", () => {
    expect(new ProviderError("PROVIDER_UNAVAILABLE").retryable).toBe(true);
    expect(new ProviderError("INVALID_PROVIDER_RESPONSE").retryable).toBe(false);
  });
});

describe("B.3.1 — provider errors: customer-safe serialization", () => {
  const leaky = new ProviderError("PROVIDER_UNAVAILABLE", {
    provider: "eupago",
    internalDetail: "apiKey=sk_live_SUPERSECRET raw payload {\"pan\":\"4111111111111111\"}",
    cause: new Error("connect ECONNREFUSED 10.0.0.1:443"),
  });

  it("never exposes stack, credentials, secrets or raw payloads", () => {
    const serialized = JSON.stringify(leaky.toCustomerSafeJSON());
    for (const forbidden of ["stack", "sk_live", "SUPERSECRET", "apiKey", "pan", "4111111111111111", "ECONNREFUSED", "10.0.0.1"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(leaky.toCustomerSafeJSON()).sort()).toEqual(["error", "message"]);
  });

  it("is customer-safe through JSON.stringify of the error itself", () => {
    const serialized = JSON.stringify(leaky);
    expect(serialized).not.toContain("SUPERSECRET");
    expect(serialized).not.toContain("internalDetail");
    expect(JSON.parse(serialized)).toEqual({
      error: "PROVIDER_UNAVAILABLE",
      message: expect.any(String),
    });
  });

  it("keeps internal detail available in-process for logging only", () => {
    expect(leaky.internalDetail).toContain("SUPERSECRET");
    expect(typeof leaky.stack).toBe("string");
  });

  it("collapses unknown errors into a safe payload", () => {
    const safe = toCustomerSafeError(new Error("DB password=hunter2 at /srv/app/src/db/index.ts:42"));
    expect(safe.error).toBe("PROVIDER_UNAVAILABLE");
    expect(JSON.stringify(safe)).not.toContain("hunter2");
    expect(JSON.stringify(safe)).not.toContain("/srv/app");
    expect(toCustomerSafeError("boom").error).toBe("PROVIDER_UNAVAILABLE");
  });

  it("preserves the normalized code when converting a ProviderError", () => {
    expect(toCustomerSafeError(new ProviderError("PAYMENT_NOT_FOUND")).error).toBe("PAYMENT_NOT_FOUND");
    expect(toCustomerSafeError(new ProviderError("SHIPMENT_NOT_FOUND")).error).toBe("SHIPMENT_NOT_FOUND");
    expect(toCustomerSafeError(new ProviderError("INVOICE_NOT_FOUND")).error).toBe("INVOICE_NOT_FOUND");
  });
});

describe("B.3.1 — provider errors: message sanitization before persistence", () => {
  it("redacts credentials and card numbers", () => {
    const dirty = 'Authorization: Bearer abc.def.ghi; api_key=sk_live_123; card 4111 1111 1111 1111';
    const clean = sanitizeErrorMessage(dirty);
    expect(clean).not.toContain("sk_live_123");
    expect(clean).not.toContain("abc.def.ghi");
    expect(clean).not.toContain("4111 1111 1111 1111");
    expect(clean).toContain("REDACTED");
  });

  it("truncates long messages and handles non-error input", () => {
    expect(sanitizeErrorMessage("x".repeat(5000)).length).toBe(500);
    expect(sanitizeErrorMessage(undefined)).toBe("UNKNOWN_ERROR");
    expect(sanitizeErrorMessage({ some: "object" })).toBe("UNKNOWN_ERROR");
    expect(sanitizeErrorMessage(new ProviderError("WEBHOOK_INVALID"))).toBe("WEBHOOK_INVALID");
  });
});
