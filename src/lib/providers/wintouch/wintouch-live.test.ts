/**
 * C.4 — Wintouch Cloud LIVE probe (real API, read-only GETs only).
 *
 * Explicitly separated from the unit tests: this file runs ONLY when
 * WINTOUCH_API_BASE_URL and WINTOUCH_API_KEY are present in the environment
 * (otherwise the suite is skipped). It performs no writes — the probe issues
 * GET requests exclusively — but it does contact the real provider, so it
 * must never run with production credentials in shared CI.
 *
 * No assertion is made on ok/authenticated: those depend on the real account
 * state. The printed result object is the diagnostic artifact.
 */

import { describe, expect, it } from "vitest";
import { probeWintouch } from "./probe";

const LIVE = Boolean(process.env.WINTOUCH_API_BASE_URL && process.env.WINTOUCH_API_KEY);

describe.skipIf(!LIVE)("C.4 — wintouch live probe (requires WINTOUCH_API_* env)", () => {
  it(
    "runs the read-only probe against the real API without leaking secrets",
    { timeout: 120_000 },
    async () => {
      const result = await probeWintouch({ timeoutMs: 10_000 });

      expect(result.checks).toHaveLength(4);
      expect(typeof result.authenticated).toBe("boolean");
      expect(typeof result.ok).toBe("boolean");
      for (const check of result.checks) {
        expect(typeof check.name).toBe("string");
        expect(typeof check.durationMs).toBe("number");
      }

      // The key must not appear anywhere in the diagnostic output.
      const key = process.env.WINTOUCH_API_KEY as string;
      expect(JSON.stringify(result)).not.toContain(key);

      console.log(JSON.stringify(result, null, 2));
    }
  );
});
