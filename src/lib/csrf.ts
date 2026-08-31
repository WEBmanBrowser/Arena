/**
 * P1 — CSRF protection via strict same-origin verification.
 *
 * Browsers always send the `Origin` header on cross-site POST/PUT/PATCH/DELETE
 * requests. Rejecting unsafe requests whose origin does not match the target
 * host blocks classical CSRF while keeping all same-site fetch/form calls
 * working (auth cookie is additionally SameSite=Lax).
 *
 * Server-to-server endpoints protected by their own secret (e.g. the cron
 * route with CRON_SECRET) are exempt from this check.
 */
import { NextRequest, NextResponse } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/** All host variants the request may legitimately target (direct + proxied). */
function allowedHosts(req: NextRequest): Set<string> {
  const hosts = new Set<string>();
  if (req.headers.get("host")) hosts.add(req.headers.get("host")!);
  if (req.nextUrl?.host) hosts.add(req.nextUrl.host);
  const forwarded = req.headers.get("x-forwarded-host");
  if (forwarded) forwarded.split(",").forEach((h) => hosts.add(h.trim()));
  const proto = req.headers.get("x-forwarded-proto");
  // Next's nextUrl.host may or may not include the port — also allow host without port
  const bare = new Set<string>();
  for (const h of hosts) bare.add(h.split(":")[0]);
  return new Set([...hosts, ...bare, ...(proto ? [] : [])]);
}

/**
 * True when the request is safe OR its Origin/Referer matches the target host.
 * Missing both headers on an unsafe request → rejected (browsers always send
 * at least one for cross-site requests).
 */
export function verifySameOrigin(req: NextRequest): boolean {
  if (isSafeMethod(req.method)) return true;

  const hosts = allowedHosts(req);
  const hostMatches = (rawUrl: string): boolean => {
    try {
      const url = new URL(rawUrl);
      return hosts.has(url.host) || hosts.has(url.hostname);
    } catch {
      return false;
    }
  };

  const origin = req.headers.get("origin");
  if (origin) return hostMatches(origin);
  const referer = req.headers.get("referer");
  if (referer) return hostMatches(referer);
  return false;
}

/** Standard 403 response for failed same-origin verification. */
export function csrfFailureResponse(): NextResponse {
  return NextResponse.json({ error: "Origem inválida (CSRF)" }, { status: 403 });
}

/** Guard: returns the 403 response when the request fails verification. */
export function csrfGuard(req: NextRequest): NextResponse | null {
  return verifySameOrigin(req) ? null : csrfFailureResponse();
}
