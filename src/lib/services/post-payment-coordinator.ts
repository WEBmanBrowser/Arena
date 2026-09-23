import { issueWintouchInvoiceForOrder } from "@/lib/services/wintouch-invoicing-service";
import { reconcileLoyaltyForOrder } from "@/lib/services/loyalty-service";

export type PostPaymentSource = "manual" | "admin" | "recovery" | "provider_webhook";
export interface PostPaymentResult { readonly invoicing: "disabled" | "issued_or_existing" | "failed"; }

/** Run post-payment effects only after the financial transaction committed. */
export async function runPostPaymentEffects(input: { orderId: number; actorId: number | null; source: PostPaymentSource; }): Promise<PostPaymentResult> {
  // Loyalty is internal and failure-isolated: a confirmed payment is never rolled back by points.
  try {
    await reconcileLoyaltyForOrder(input.orderId, input.actorId);
  } catch (error) {
    const code = error instanceof Error ? error.message : "LOYALTY_ERROR";
    console.error("Loyalty post-payment reconciliation failed", { orderId: input.orderId, source: input.source, code });
  }
  if (process.env.WINTOUCH_AUTO_INVOICE_PAID?.trim().toLowerCase() !== "true") return { invoicing: "disabled" };
  try {
    await issueWintouchInvoiceForOrder(input.orderId, input.actorId);
    return { invoicing: "issued_or_existing" };
  } catch (error) {
    const code = error instanceof Error ? error.message : "WINTOUCH_ERROR";
    console.error("WINTOUCH post-payment invoicing failed", { orderId: input.orderId, source: input.source, code });
    return { invoicing: "failed" };
  }
}
