/**
 * C.4 — Wintouch Cloud probe unit tests (fully mocked transport).
 *
 * The central guarantee under test: the probe result NEVER contains the API
 * key (or response values at all) — even when the provider echoes secrets
 * back inside response values or error bodies.
 */

import { describe, expect, it, vi } from "vitest";
import { isProviderError } from "../errors";
import { probeWintouch, redactSecrets } from "./probe";
import type { WintouchConfig } from "./config";

const FAKE_KEY = "test-fake-wintouch-key-1111-DO-NOT-USE";
const BASE = "https://tenant.example.com";

function testConfig(): WintouchConfig {
  return { baseUrl: BASE, apiKey: FAKE_KEY };
}

function jsonResponse(status: number, payload: unknown): Response {
  return {
    status,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  } as Response;
}

/** Route mocked responses by request path. */
function router(routes: Record<string, { status: number; payload: unknown }>): typeof fetch {
  return (async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    const hit = Object.entries(routes).find(([suffix]) => path.endsWith(suffix));
    if (!hit) return jsonResponse(404, { error: "no mock route" });
    return jsonResponse(hit[1].status, hit[1].payload);
  }) as typeof fetch;
}

describe("C.4 — wintouch probe: happy path", () => {
  it("reports ok with counts and key-only shapes (values never included)", async () => {
    const secretValue = "super-secret-entity-value-999";
    const fetchImpl = router({
      "/api/v1/document_types": { status: 200, payload: [{ Code: "FT", Description: "Fatura" }] },
      "/api/v1/payment_methods": { status: 200, payload: [{ Code: "MB", Name: "Multibanco" }] },
      "/entities": { status: 200, payload: [{ EntityID: 7, Name: secretValue }] },
      "/api/v1/product_documents": { status: 200, payload: [] },
    });
    const result = await probeWintouch({ config: testConfig(), fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.baseUrl).toBe(BASE);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.map((c) => c.name)).toEqual([
      "document_types",
      "payment_methods",
      "entities",
      "product_documents",
    ]);

    const entities = result.checks.find((c) => c.name === "entities");
    expect(entities?.ok).toBe(true);
    expect(entities?.status).toBe(200);
    expect(entities?.outcome).toBe("ok");
    expect(entities?.count).toBe(1);
    expect(entities?.shape).toEqual(["EntityID", "Name"]);

    const docs = result.checks.find((c) => c.name === "product_documents");
    expect(docs?.count).toBe(0);
    expect(docs?.shape).toBeNull();

    // Values — including adversarial ones — never appear in the output.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain("Fatura");
    expect(serialized).not.toContain(FAKE_KEY);
    expect(Number.isNaN(Date.parse(result.probedAt))).toBe(false);
    expect(typeof result.durationMs).toBe("number");
  });

  it("skips product_documents when asked", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []));
    const result = await probeWintouch({ config: testConfig(), fetchImpl, includeProductDocuments: false });
    expect(result.checks).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("C.4 — wintouch probe: auth and error mapping", () => {
  it("maps 401 everywhere to authenticated=false with auth_failed outcomes", async () => {
    const result = await probeWintouch({
      config: testConfig(),
      fetchImpl: async () => jsonResponse(401, { error: "invalid api key" }),
    });
    expect(result.ok).toBe(false);
    expect(result.authenticated).toBe(false);
    for (const check of result.checks) {
      expect(check.status).toBe(401);
      expect(check.outcome).toBe("auth_failed");
      expect(check.ok).toBe(false);
    }
  });

  it("stays authenticated when the key is accepted anywhere (mixed 200 + 403)", async () => {
    const fetchImpl = router({
      "/api/v1/document_types": { status: 200, payload: [] },
      "/api/v1/payment_methods": { status: 403, payload: { error: "forbidden" } },
      "/entities": { status: 200, payload: [] },
      "/api/v1/product_documents": { status: 200, payload: [] },
    });
    const result = await probeWintouch({ config: testConfig(), fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.authenticated).toBe(true);
    expect(result.checks.find((c) => c.name === "payment_methods")?.outcome).toBe("auth_failed");
  });

  it("maps 404 to not_found and other 4xx to client_error with sanitized excerpts", async () => {
    const fetchImpl = router({
      "/api/v1/document_types": { status: 404, payload: { error: "no such resource" } },
      "/api/v1/payment_methods": { status: 400, payload: { error: "bad filter syntax" } },
      "/entities": { status: 200, payload: [] },
      "/api/v1/product_documents": { status: 200, payload: [] },
    });
    const result = await probeWintouch({ config: testConfig(), fetchImpl });
    expect(result.checks.find((c) => c.name === "document_types")?.outcome).toBe("not_found");
    const pm = result.checks.find((c) => c.name === "payment_methods");
    expect(pm?.outcome).toBe("client_error");
    expect(pm?.error).toContain("bad filter syntax");
  });

  it("maps 5xx to ambiguous with the status preserved", async () => {
    const result = await probeWintouch({
      config: testConfig(),
      fetchImpl: async () => jsonResponse(503, { error: "overloaded" }),
    });
    for (const check of result.checks) {
      expect(check.outcome).toBe("ambiguous");
      expect(check.reason).toBe("server_error");
      expect(check.status).toBe(503);
    }
    expect(result.authenticated).toBe(true);
  });

  it("maps timeouts to ambiguous without a status", async () => {
    const result = await probeWintouch({
      config: testConfig(),
      timeoutMs: 5,
      fetchImpl: ((_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })) as typeof fetch,
    });
    for (const check of result.checks) {
      expect(check.outcome).toBe("ambiguous");
      expect(check.reason).toBe("timeout");
      expect(check.status).toBeNull();
    }
    expect(result.authenticated).toBe(false);
  });
});

describe("C.4 — wintouch probe: secrets never appear in output", () => {
  it("redactSecrets removes every occurrence of known secrets", () => {
    expect(redactSecrets(`a ${FAKE_KEY} b ${FAKE_KEY}`, [FAKE_KEY])).toBe("a [REDACTED] b [REDACTED]");
    expect(redactSecrets("untouched", [FAKE_KEY])).toBe("untouched");
    expect(redactSecrets(`x ${FAKE_KEY}`, [])).toContain(FAKE_KEY);
    expect(redactSecrets("x", [""])).toBe("x");
  });

  it("survives an API that echoes the key in values, keys and error bodies", async () => {
    const fetchImpl = router({
      "/api/v1/document_types": {
        status: 200,
        payload: [{ Code: "FT", DebugEcho: FAKE_KEY, [FAKE_KEY]: "key-as-field-name" }],
      },
      "/api/v1/payment_methods": { status: 400, payload: { error: `rejected: ApiKey ${FAKE_KEY}` } },
      "/entities": { status: 200, payload: [] },
      "/api/v1/product_documents": { status: 200, payload: [] },
    });
    const result = await probeWintouch({ config: testConfig(), fetchImpl });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FAKE_KEY);
    // The labeled echo is redacted through the shared sanitizer as well.
    expect(JSON.stringify(result.checks)).toContain("[REDACTED]");
  });

  it("fails closed on missing config BEFORE any network call", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []));
    try {
      await probeWintouch({ env: {}, fetchImpl });
      expect.unreachable("must throw");
    } catch (e) {
      expect(isProviderError(e)).toBe(true);
      if (isProviderError(e)) expect(e.code).toBe("PROVIDER_UNAVAILABLE");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
