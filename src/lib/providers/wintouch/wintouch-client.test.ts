/**
 * C.4 — Wintouch Cloud client unit tests (config + transport, fully mocked).
 *
 * No network, no database, no real credentials. The fake key below is
 * distinctive so redaction assertions cannot pass by accident.
 */

import { describe, expect, it, vi } from "vitest";
import { isProviderError } from "../errors";
import {
  isAuthFailure,
  wintouchRequest,
  WINTOUCH_DEFAULT_TIMEOUT_MS,
  type WintouchRequestOptions,
} from "./client";
import {
  normalizeBaseUrl,
  resolveWintouchConfig,
  wintouchUrl,
  type WintouchConfig,
  type WintouchEndpoint,
} from "./config";

const FAKE_KEY = "test-fake-wintouch-key-0000-DO-NOT-USE";
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

function baseOptions(overrides: Partial<WintouchRequestOptions> = {}): WintouchRequestOptions {
  return {
    config: testConfig(),
    endpoint: "entities",
    method: "GET",
    fetchImpl: async () => jsonResponse(200, []),
    ...overrides,
  };
}

// ─── Configuration ─────────────────────────────────────────

describe("C.4 — wintouch config: fail-closed resolution", () => {
  it("resolves valid configuration from env", () => {
    const config = resolveWintouchConfig({
      WINTOUCH_API_BASE_URL: "https://tenant.example.com/api/",
      WINTOUCH_API_KEY: FAKE_KEY,
    });
    // Trailing slashes are stripped during normalization.
    expect(config).toEqual({ baseUrl: `${BASE}/api`, apiKey: FAKE_KEY });
  });

  it("throws when the base URL is missing", () => {
    try {
      resolveWintouchConfig({ WINTOUCH_API_KEY: FAKE_KEY });
      expect.unreachable("must throw");
    } catch (e) {
      expect(isProviderError(e)).toBe(true);
      if (isProviderError(e)) {
        expect(e.code).toBe("PROVIDER_UNAVAILABLE");
        expect(e.internalDetail).toContain("WINTOUCH_API_BASE_URL");
      }
    }
  });

  it("throws when the API key is missing or blank", () => {
    for (const env of [{}, { WINTOUCH_API_KEY: "   " }]) {
      try {
        resolveWintouchConfig({ WINTOUCH_API_BASE_URL: BASE, ...env });
        expect.unreachable("must throw");
      } catch (e) {
        expect(isProviderError(e)).toBe(true);
        if (isProviderError(e)) {
          expect(e.code).toBe("PROVIDER_UNAVAILABLE");
          expect(e.internalDetail).toContain("WINTOUCH_API_KEY");
        }
      }
    }
  });

  it("names only the variable — never the value — on failure", () => {
    try {
      resolveWintouchConfig({ WINTOUCH_API_BASE_URL: BASE });
      expect.unreachable("must throw");
    } catch (e) {
      expect(isProviderError(e)).toBe(true);
      // The variable name is available in-process for logging only...
      if (isProviderError(e)) expect(e.internalDetail).toContain("WINTOUCH_API_KEY");
      // ...and the serialized form carries no secret material at all.
      expect(JSON.stringify(e)).not.toContain(FAKE_KEY);
      expect(JSON.stringify(e)).not.toContain("WINTOUCH_API_KEY");
    }
  });
});

describe("C.4 — wintouch config: base URL validation (SSRF safety)", () => {
  it("accepts https origins with a path prefix", () => {
    expect(normalizeBaseUrl("https://tenant.example.com/api")).toBe(`${BASE}/api`);
    expect(normalizeBaseUrl("https://tenant.example.com/api///")).toBe(`${BASE}/api`);
    expect(normalizeBaseUrl("https://host.example:8443/deep/prefix")).toBe("https://host.example:8443/deep/prefix");
  });

  it("rejects non-URLs and control characters", () => {
    for (const bad of ["not-a-url", "", "   ", "https://host.example/\n", "ftp://host.example/api"]) {
      expect(() => normalizeBaseUrl(bad)).toThrowError(/indisponível/);
    }
  });

  it("rejects plain http except on loopback", () => {
    expect(() => normalizeBaseUrl("http://tenant.example.com/api")).toThrowError(/indisponível/);
    expect(normalizeBaseUrl("http://localhost:8080/api")).toBe("http://localhost:8080/api");
    expect(normalizeBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  it("rejects credentials, query strings and fragments", () => {
    for (const bad of [
      "https://user:pass@tenant.example.com/api",
      "https://tenant.example.com/api?token=abc",
      "https://tenant.example.com/api#frag",
    ]) {
      expect(() => normalizeBaseUrl(bad)).toThrowError(/indisponível/);
    }
  });

  it("rejects API keys with header-injection characters", () => {
    for (const badKey of ["abc\r\nX-Injected: 1", "abc\0def"]) {
      expect(() => resolveWintouchConfig({ WINTOUCH_API_BASE_URL: BASE, WINTOUCH_API_KEY: badKey })).toThrowError(
        /indisponível/
      );
    }
  });
});

describe("C.4 — wintouch config: endpoint allowlist", () => {
  it("builds allowlisted absolute URLs", () => {
    const config = testConfig();
    expect(wintouchUrl(config, "documentTypes")).toBe(`${BASE}/api/v1/document_types`);
    expect(wintouchUrl(config, "paymentMethods")).toBe(`${BASE}/api/v1/payment_methods`);
    expect(wintouchUrl(config, "entities")).toBe(`${BASE}/api/v1/entities`);
    expect(wintouchUrl(config, "productDocuments")).toBe(`${BASE}/api/v1/product_documents`);
  });

  it("rejects non-allowlisted endpoints at runtime", () => {
    expect(() => wintouchUrl(testConfig(), "admin" as WintouchEndpoint)).toThrowError(/não suportada/);
  });
});

// ─── Transport ─────────────────────────────────────────────

describe("C.4 — wintouch transport: auth header and request shape", () => {
  it("sends Authorization: ApiKey <key> and never puts the key in the URL", async () => {
    const seen: Array<{ url: unknown; init: unknown }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
      seen.push({ url, init });
      return jsonResponse(200, []);
    });
    await wintouchRequest({ ...baseOptions(), fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [{ url, init }] = seen as Array<{ url: string; init: { headers: Record<string, string> } }>;
    expect(url).toBe(`${BASE}/api/v1/entities`);
    expect(url).not.toContain(FAKE_KEY);
    expect(init.headers["Authorization"]).toBe(`ApiKey ${FAKE_KEY}`);
    expect(init.headers["Accept-Language"]).toBe("pt-PT");
    expect(init.headers["Accept"]).toBe("application/json");
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("serializes POST bodies as JSON with Content-Type", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { id: 1 }));
    const res = await wintouchRequest({
      ...baseOptions(),
      endpoint: "entities",
      method: "POST",
      body: { Code: "C001" },
      fetchImpl,
    });
    expect(res).toEqual({ kind: "ok", status: 201, body: { id: 1 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [unknown, { headers: Record<string, string>; body: string }];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ Code: "C001" }));
  });

  it("appends encoded query strings", async () => {
    let capturedUrl = "";
    await wintouchRequest({
      ...baseOptions(),
      query: { code: "A B", top: "10" },
      fetchImpl: (async (url: unknown) => {
        capturedUrl = String(url);
        return jsonResponse(200, []);
      }) as typeof fetch,
    });
    expect(capturedUrl).toBe(`${BASE}/api/v1/entities?code=A+B&top=10`);
  });

  it("exposes the default timeout", () => {
    expect(WINTOUCH_DEFAULT_TIMEOUT_MS).toBe(15_000);
  });
});

describe("C.4 — wintouch transport: status mapping (definitive vs ambiguous)", () => {
  it("treats 2xx with JSON (object or array) as ok", async () => {
    const arr = await wintouchRequest({ ...baseOptions(), fetchImpl: async () => jsonResponse(200, [{ a: 1 }]) });
    expect(arr).toEqual({ kind: "ok", status: 200, body: [{ a: 1 }] });
    const obj = await wintouchRequest({ ...baseOptions(), fetchImpl: async () => jsonResponse(200, { a: 1 }) });
    expect(obj).toEqual({ kind: "ok", status: 200, body: { a: 1 } });
  });

  it("treats empty bodies as ok with null body (status preserved)", async () => {
    const res = await wintouchRequest({
      ...baseOptions(),
      fetchImpl: (async () => ({ status: 204, text: async () => "" }) as Response) as typeof fetch,
    });
    expect(res).toEqual({ kind: "ok", status: 204, body: null });
  });

  it.each([401, 403])("returns %i as a DEFINITIVE ok outcome (auth rejected, never ambiguous)", async (status) => {
    const res = await wintouchRequest({
      ...baseOptions(),
      fetchImpl: async () => jsonResponse(status, { error: "unauthorized" }),
    });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: "unauthorized" });
    }
    expect(isAuthFailure(status)).toBe(true);
  });

  it.each([400, 404, 422])("returns %i as ok with the error body preserved", async (status) => {
    const res = await wintouchRequest({
      ...baseOptions(),
      fetchImpl: async () => jsonResponse(status, { error: "bad request" }),
    });
    expect(res).toEqual({ kind: "ok", status, body: { error: "bad request" } });
    expect(isAuthFailure(status)).toBe(false);
  });

  it.each([500, 502, 503])("maps %i to ambiguous server_error (may have executed)", async (status) => {
    const res = await wintouchRequest({
      ...baseOptions(),
      fetchImpl: async () => jsonResponse(status, { error: "boom" }),
    });
    expect(res).toEqual({ kind: "ambiguous", reason: "server_error", status });
  });

  it("maps unparseable bodies to ambiguous malformed_response", async () => {
    const res = await wintouchRequest({
      ...baseOptions(),
      fetchImpl: (async () => ({ status: 200, text: async () => "<html>not json" }) as Response) as typeof fetch,
    });
    expect(res).toEqual({ kind: "ambiguous", reason: "malformed_response", status: 200 });
  });

  it("maps network failures to ambiguous network_error", async () => {
    const res = await wintouchRequest({
      ...baseOptions(),
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch,
    });
    expect(res).toEqual({ kind: "ambiguous", reason: "network_error" });
  });

  it("maps aborts to ambiguous timeout", async () => {
    const hanging = ((_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as typeof fetch;
    const res = await wintouchRequest({ ...baseOptions(), timeoutMs: 5, fetchImpl: hanging });
    expect(res).toEqual({ kind: "ambiguous", reason: "timeout" });
  });
});

describe("WINTOUCH entity VAT transport safety", () => {
  it("builds the allowlisted by_vat entity lookup", async () => {
    let requestedUrl = "";

    const fetchImpl: typeof fetch = async (
      input,
      init,
    ) => {
      requestedUrl = String(input);

      expect(init?.method).toBe("GET");

      return new Response(
        JSON.stringify({
          ID: "11111111-1111-4111-8111-111111111111",
          VATNumber: "123456789",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    };

    const config = {
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
    };

    const result = await wintouchRequest({
      config,
      endpoint: "entities",
      method: "GET",
      entityVatNumber: "123456789",
      enterpriseId:
        "22222222-2222-4222-8222-222222222222",
      fetchImpl,
    });

    expect(result.kind).toBe("ok");

    expect(requestedUrl).toBe(
      "https://api.example.test/api/v1/entities/by_vat/123456789",
    );
  });

  it("rejects malformed VAT lookup before transport", async () => {
    let called = false;

    const fetchImpl: typeof fetch = async () => {
      called = true;

      return new Response(
        JSON.stringify({}),
        { status: 200 },
      );
    };

    const config = {
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
    };

    await expect(
      wintouchRequest({
        config,
        endpoint: "entities",
        method: "GET",
        entityVatNumber: "../123",
        fetchImpl,
      }),
    ).rejects.toBeDefined();

    expect(called).toBe(false);
  });

  it("does not allow by_vat on another endpoint", async () => {
    let called = false;

    const fetchImpl: typeof fetch = async () => {
      called = true;

      return new Response(
        JSON.stringify({}),
        { status: 200 },
      );
    };

    const config = {
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
    };

    await expect(
      wintouchRequest({
        config,
        endpoint: "productDocuments",
        method: "GET",
        entityVatNumber: "123456789",
        fetchImpl,
      }),
    ).rejects.toBeDefined();

    expect(called).toBe(false);
  });

  it("does not allow resourceId and VAT lookup together", async () => {
    let called = false;

    const fetchImpl: typeof fetch = async () => {
      called = true;

      return new Response(
        JSON.stringify({}),
        { status: 200 },
      );
    };

    const config = {
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
    };

    await expect(
      wintouchRequest({
        config,
        endpoint: "entities",
        method: "GET",
        resourceId:
          "11111111-1111-4111-8111-111111111111",
        entityVatNumber: "123456789",
        fetchImpl,
      }),
    ).rejects.toBeDefined();

    expect(called).toBe(false);
  });
});
