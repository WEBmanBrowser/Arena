/**
 * P1 — Postgres-backed fixed-window rate limiting.
 * Cloudflare Workers compatible (no in-memory state between requests).
 * Atomic via INSERT ... ON CONFLICT — safe under concurrency.
 */
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export interface RateLimitOptions {
  /** Max allowed hits per window */
  limit: number;
  /** Window length in seconds */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  /** Seconds until the window resets (0 when allowed) */
  retryAfterSeconds: number;
}

/**
 * Consume one hit for `key`. Fixed window: the first hit opens a window of
 * `windowSeconds`; hits beyond `limit` are rejected until the window expires.
 */
export async function checkRateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  const { limit, windowSeconds } = opts;
  const rows = await db.execute(sql`
    INSERT INTO rate_limits (key, count, window_start, expires_at)
    VALUES (${key}, 1, now(), now() + make_interval(secs => ${windowSeconds}))
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.window_start <= now() - make_interval(secs => ${windowSeconds}) THEN 1
        ELSE rate_limits.count + 1
      END,
      window_start = CASE
        WHEN rate_limits.window_start <= now() - make_interval(secs => ${windowSeconds}) THEN now()
        ELSE rate_limits.window_start
      END,
      expires_at = now() + make_interval(secs => ${windowSeconds})
    RETURNING count, window_start, expires_at
  `);
  const row = (rows.rows?.[0] ?? {}) as { count?: number | string; window_start?: string | Date; expires_at?: string | Date };
  const count = Number(row.count ?? 1);
  const expiresAt = row.expires_at ? new Date(row.expires_at) : new Date(Date.now() + windowSeconds * 1000);
  const retryAfterSeconds = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  return {
    allowed: count <= limit,
    count,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: count <= limit ? 0 : retryAfterSeconds,
  };
}

/** Build the standard 429 response with Retry-After. */
export function rateLimitResponse(retryAfterSeconds: number, message = "Demasiadas tentativas. Tenta novamente mais tarde."): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 429, headers: { "retry-after": String(Math.max(1, retryAfterSeconds)) } },
  );
}

/** Best-effort client IP (Cloudflare first, then standard proxies). */
export function clientIp(req: NextRequest): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/** Housekeeping: delete fully expired windows (call opportunistically). */
export async function cleanupExpiredRateLimits(): Promise<number> {
  const res = await db.execute(sql`DELETE FROM rate_limits WHERE expires_at < now()`);
  return res.rowCount ?? 0;
}
