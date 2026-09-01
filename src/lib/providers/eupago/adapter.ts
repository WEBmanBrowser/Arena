/**
 * B.3.2 — Eupago PaymentProviderAdapter + EXPLICIT registration.
 *
 * Registration is a deliberate function call (`registerEupago()`), never an
 * import side effect: importing a module must not silently mutate the global
 * provider registry, because that makes behaviour depend on module graph
 * ordering and makes tests leak into each other.
 *
 * Runtime: fetch + Web Crypto only — Cloudflare Workers / OpenNext compatible.
 */

import {
  registerPaymentAdapter,
  type PaymentIntentRequest,
  type PaymentIntentResult,
  type PaymentProviderAdapter,
} from "../payment-attempts";
import { ProviderError } from "../errors";
import { EUPAGO_PROVIDER_ID } from "./config";
import { db } from "@/db";
import { paymentAttempts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { createEupagoPayment } from "@/lib/services/eupago-payment-service";

export const eupagoPaymentAdapter: PaymentProviderAdapter = {
  provider: EUPAGO_PROVIDER_ID,

  async createPayment(request: PaymentIntentRequest): Promise<PaymentIntentResult> {
    const result = await createEupagoPayment({
      orderId: request.orderId,
      method: request.method,
      amountCents: request.amountCents,
      currency: request.currency,
    });

    if (result.outcome === "created") {
      return {
        providerReference: result.attempt.providerReference!,
        // Creation is NOT settlement — the attempt stays pending.
        status: "pending",
        expiresAt: result.attempt.expiresAt,
      };
    }
    if (result.outcome === "rejected") {
      throw new ProviderError("INVALID_PROVIDER_RESPONSE", {
        provider: EUPAGO_PROVIDER_ID,
        internalDetail: `create rejected: ${result.code}`,
      });
    }
    throw new ProviderError("PROVIDER_UNAVAILABLE", {
      provider: EUPAGO_PROVIDER_ID,
      internalDetail: `create ambiguous: ${result.code}`,
    });
  },

  /**
   * Local view of provider state. Deliberately reads the persisted attempt
   * rather than polling: settlement truth arrives via signed webhooks, and a
   * read-through poll would invite treating a lookup failure as a state.
   */
  async getPayment(providerReference: string): Promise<PaymentIntentResult> {
    const [row] = await db
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.provider, EUPAGO_PROVIDER_ID),
          eq(paymentAttempts.providerReference, providerReference)
        )
      )
      .limit(1);
    if (!row) {
      throw new ProviderError("PAYMENT_NOT_FOUND", {
        provider: EUPAGO_PROVIDER_ID,
        internalDetail: "unknown provider reference",
      });
    }
    return {
      providerReference,
      status: row.status as PaymentIntentResult["status"],
      expiresAt: row.expiresAt,
    };
  },
};

/** Explicitly register the Eupago adapter. Idempotent. */
export function registerEupago(): void {
  registerPaymentAdapter(eupagoPaymentAdapter);
}
