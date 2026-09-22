import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ issue: vi.fn() }));
vi.mock("@/lib/services/wintouch-invoicing-service", () => ({ issueWintouchInvoiceForOrder: mocks.issue }));
import { runPostPaymentEffects } from "@/lib/services/post-payment-coordinator";

describe("post-payment coordinator", () => {
  beforeEach(() => { vi.clearAllMocks(); delete process.env.WINTOUCH_AUTO_INVOICE_PAID; });
  it("is disabled unless rollout flag is true", async () => {
    expect(await runPostPaymentEffects({ orderId: 1, actorId: null, source: "provider_webhook" })).toEqual({ invoicing: "disabled" });
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("uses the existing WINTOUCH idempotent service when enabled", async () => {
    process.env.WINTOUCH_AUTO_INVOICE_PAID = "true"; mocks.issue.mockResolvedValue({ id: 10 });
    expect(await runPostPaymentEffects({ orderId: 2, actorId: 7, source: "admin" })).toEqual({ invoicing: "issued_or_existing" });
    expect(mocks.issue).toHaveBeenCalledWith(2, 7);
  });
  it("isolates WINTOUCH failure from the committed payment", async () => {
    process.env.WINTOUCH_AUTO_INVOICE_PAID = "true"; mocks.issue.mockRejectedValue(new Error("PROVIDER_UNAVAILABLE"));
    const spy=vi.spyOn(console,"error").mockImplementation(() => undefined);
    expect(await runPostPaymentEffects({ orderId: 3, actorId: null, source: "provider_webhook" })).toEqual({ invoicing: "failed" });
    expect(mocks.issue).toHaveBeenCalledTimes(1); spy.mockRestore();
  });
});
