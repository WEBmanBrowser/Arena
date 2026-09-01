/**
 * B.3.2 — POST /api/webhooks/eupago
 *
 * Machine-to-machine endpoint for Eupago Realtime Webhooks 2.0.
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
    // 200 for every handled outcome (including duplicates and ignored events)
    // so the provider stops retrying a delivery we have already reasoned about.
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
