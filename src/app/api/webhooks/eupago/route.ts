/**
 * B.3.2 — POST /api/webhooks/eupago
 *
 * Machine-to-machine endpoint for Eupago Realtime Webhooks 2.0.
 *
 * RETRYABLE ACKNOWLEDGEMENT (H2/HIGH-3)
 *  A signature-verified delivery whose correlation cannot be established YET is
 *  answered with a RETRYABLE status (503 + Retry-After) instead of a blanket 200.
 *  A 200 would be a final acknowledgement of a movement we have not been able to
 *  correlate, leaving the money invisible forever. The provider retry is the
 *  bounded re-drive: nothing is scheduled internally, no cron and no loop exists,
 *  and the delivery is parked in the re-evaluable `pending` state rather than
 *  terminally `ignored`. Once the local reference exists, the SAME trid settles
 *  exactly once.
 *
 * SECURITY MODEL (deliberately NOT browser CSRF)
 *  Eupago is a server, not a browser: it has no Origin header and no session
 *  cookie, so same-origin CSRF validation is meaningless here and is NOT
 *  applied. Existing CSRF protection on admin/customer browser mutations is
 *  untouched. This endpoint is secured by:
 *    • strict HTTP method (POST only; everything else 405)
 *    • MANDATORY X-Signature HMAC verification (fail closed)
 *    • raw-body integrity (the body is read ONCE, byte-exact, and is never
 *      re-serialized before verification)
 *    • provider correlation + amount/currency/method validation
 *    • trid-based deduplication in the existing B.3.1 webhook ledger
 *
 * The raw body is never persisted (only its sha256 hash) and provider
 * internals never appear in the response.
 */

import { NextRequest, NextResponse } from "next/server";
import { processEupagoWebhook } from "@/lib/services/eupago-settlement-service";
import { isProviderError } from "@/lib/providers/errors";

export const dynamic = "force-dynamic";

/**
 * Backoff hint attached to the retryable answer. Deliberately short and constant
 * (no escalation, no internal scheduling): the provider's own retry policy decides
 * how often the movement is offered again, and its budget for the delivery is what
 * bounds the attempts.
 */
const DEFERRED_RETRY_AFTER_SECONDS = 60;

export async function POST(req: NextRequest) {
  // Read the body EXACTLY as received. Any parse/re-stringify round trip here
  // would break signature verification for encrypt=false deliveries.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: "WEBHOOK_INVALID" }, { status: 400 });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  try {
    const result = await processEupagoWebhook({ rawBody, headers });

    // H2/HIGH-3 — a deferred delivery is NOT acknowledged as final. The response
    // must be retryable so the provider redelivers the same trid until the local
    // reference exists and the movement settles exactly once. The body stays
    // terse: no local identifiers, no payloads, no provider internals.
    if (result.outcome === "deferred") {
      return NextResponse.json(
        { received: false, retry: true, outcome: result.outcome },
        { status: 503, headers: { "Retry-After": String(DEFERRED_RETRY_AFTER_SECONDS) } }
      );
    }

    // 200 for every other handled outcome (including duplicates, ignored events
    // and recorded financial anomalies) so the provider stops retrying a delivery
    // we have already reasoned about and persisted.
    return NextResponse.json({ received: true, outcome: result.outcome }, { status: 200 });
  } catch (e) {
    if (isProviderError(e) && e.code === "WEBHOOK_INVALID") {
      // Signature/structure failure — fail closed, no provider detail leaked.
      return NextResponse.json({ error: "WEBHOOK_INVALID" }, { status: 401 });
    }
    console.error("Eupago webhook processing error");
    return NextResponse.json({ error: "PROVIDER_UNAVAILABLE" }, { status: 500 });
  }
}

/** Only POST is accepted — every other method is rejected outright. */
export async function GET() {
  return NextResponse.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
}
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
