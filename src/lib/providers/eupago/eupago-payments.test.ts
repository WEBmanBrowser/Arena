// B.3.2 — Eupago payment creation contract tests.
// No network: fetch is stubbed and every request is asserted.
// Dummy credentials only.

import { describe, it, expect } from "vitest";
import {
  MULTIBANCO_PER_DUP_SINGLE_PAYMENT,
  createCardRequest,
  createMbwayRequest,
  createMultibancoReference,
  isEupagoHostedUrl,
} from "./payments";
import { eupagoUrl, isValidTrid, type EupagoConfig } from "./config";
import { lookupByIdentifier } from "./recovery";
import { clearEupagoTokenCache, getEupagoAccessToken } from "./client";
import { ProviderError } from "../errors";

const CONFIG: EupagoConfig = {
  environment: "sandbox",
  apiKey: "dummy-api-key",
  oauthClientId: "dummy-client-id",
  oauthClientSecret: "dummy-client-secret",
  webhookKey: "0123456789abcdef0123456789abcdef",
};

const IDENTIFIER = "MDT-1-aabbccddeeff001122";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function stubFetch(
  responder: (captured: Captured) => { status: number; body: unknown } | Promise<never>
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const captured: Captured = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    calls.push(captured);
    const result = await responder(captured);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function tokenResponse() {
  return { status: 200, body: { access_token: "dummy-token", expires_in: 300 } };
}

describe("B.3.2 — endpoint allowlist (no arbitrary base URL)", () => {
  it("resolves only documented sandbox/production URLs", () => {
    expect(eupagoUrl("sandbox", "multibancoCreate")).toBe(
      "https://sandbox.eupago.pt/clientes/rest_api/multibanco/create"
    );
    expect(eupagoUrl("sandbox", "mbwayCreate")).toBe("https://sandbox.eupago.pt/api/v1.02/mbway/create");
    expect(eupagoUrl("sandbox", "creditCardCreate")).toBe(
      "https://sandbox.eupago.pt/api/v1.02/creditcard/create"
    );
    expect(eupagoUrl("sandbox", "authToken")).toBe("https://sandbox.eupago.pt/api/auth/token");
    expect(eupagoUrl("sandbox", "referencesInfo")).toBe(
      "https://sandbox.eupago.pt/api/management/v1.02/references/info"
    );
    // Sandbox → production is a HOST swap only, exactly as documented.
    expect(eupagoUrl("production", "authToken")).toBe("https://clientes.eupago.pt/api/auth/token");
  });

  it("rejects a trid that could escape the refund path (SSRF/traversal)", () => {
    expect(eupagoUrl("sandbox", "refund", { trid: "T-123" })).toBe(
      "https://sandbox.eupago.pt/api/management/v1.02/refund/T-123"
    );
    for (const evil of ["../../evil", "a/b", "http://evil.test", "a?x=1", "a#f", ""]) {
      expect(() => eupagoUrl("sandbox", "refund", { trid: evil })).toThrow(ProviderError);
      expect(isValidTrid(evil)).toBe(false);
    }
  });
});

describe("B.3.2 — Multibanco creation", () => {
  it("posts to the documented endpoint with body auth and per_dup = 0", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: {
        sucesso: true,
        estado: 0,
        referencia: "123456789",
        entidade: "12345",
        valor: "12.34",
        data_fim: "2026-09-30",
      },
    }));

    const result = await createMultibancoReference({
      config: CONFIG,
      identifier: IDENTIFIER,
      amountCents: 1234,
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sandbox.eupago.pt/clientes/rest_api/multibanco/create");
    expect(calls[0].method).toBe("POST");
    // BODY-AUTH contract: chave travels in the body, not in a header.
    expect(calls[0].body).toMatchObject({
      chave: "dummy-api-key",
      valor: "12.34",
      id: IDENTIFIER,
      per_dup: 0,
    });
    expect(MULTIBANCO_PER_DUP_SINGLE_PAYMENT).toBe(0);
    expect(calls[0].headers).not.toHaveProperty("Authorization");

    expect(result.kind).toBe("created");
    if (result.kind === "created") {
      expect(result.reference).toBe("123456789");
      expect(result.entity).toBe("12345");
      expect(result.expiresAt).toBeInstanceOf(Date);
    }
  });

  it("formats amounts as deterministic decimal strings from integer cents", async () => {
    const seen: string[] = [];
    const { fetchImpl } = stubFetch((c) => {
      seen.push(String((c.body as { valor: string }).valor));
      return { status: 200, body: { sucesso: true, estado: 0, referencia: "1", entidade: "2" } };
    });
    for (const cents of [1, 100, 1005, 99999999]) {
      await createMultibancoReference({ config: CONFIG, identifier: IDENTIFIER, amountCents: cents, fetchImpl });
    }
    expect(seen).toEqual(["0.01", "1.00", "10.05", "999999.99"]);
  });

  it("treats HTTP 200 with a semantic failure as REJECTED, not success", async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: { sucesso: false, estado: 3, resposta: "Chave inválida" },
    }));
    const result = await createMultibancoReference({
      config: CONFIG,
      identifier: IDENTIFIER,
      amountCents: 1000,
      fetchImpl,
    });
    expect(result.kind).toBe("rejected");
  });

  it("treats HTTP 200 claiming success but missing reference/entity as ambiguous", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 200, body: { sucesso: true, estado: 0 } }));
    const result = await createMultibancoReference({
      config: CONFIG,
      identifier: IDENTIFIER,
      amountCents: 1000,
      fetchImpl,
    });
    expect(result).toMatchObject({ kind: "ambiguous", reason: "malformed_response" });
  });

  it("treats 5xx, network errors and malformed bodies as AMBIGUOUS (never failure)", async () => {
    const server = stubFetch(() => ({ status: 503, body: {} }));
    await expect(
      createMultibancoReference({ config: CONFIG, identifier: IDENTIFIER, amountCents: 100, fetchImpl: server.fetchImpl })
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "server_error" });

    const netFetch = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    await expect(
      createMultibancoReference({ config: CONFIG, identifier: IDENTIFIER, amountCents: 100, fetchImpl: netFetch })
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "network_error" });

    const badFetch = (async () =>
      new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(
      createMultibancoReference({ config: CONFIG, identifier: IDENTIFIER, amountCents: 100, fetchImpl: badFetch })
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "malformed_response" });
  });

  it("reports a timeout/abort as ambiguous", async () => {
    const abortFetch = (async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    await expect(
      createMultibancoReference({ config: CONFIG, identifier: IDENTIFIER, amountCents: 100, fetchImpl: abortFetch })
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "timeout" });
  });

  it("rejects an invalid stable identifier before any network call", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: {} }));
    await expect(
      createMultibancoReference({ config: CONFIG, identifier: "short", amountCents: 100, fetchImpl })
    ).rejects.toThrow(ProviderError);
    expect(calls).toHaveLength(0);
  });
});

describe("B.3.2 — MB WAY creation", () => {
  it("uses ApiKey auth and the documented payment/customer body", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 201,
      body: { transactionStatus: "Success", transactionID: "TX-1", reference: "REF-1" },
    }));

    const result = await createMbwayRequest({
      config: CONFIG,
      identifier: IDENTIFIER,
      amountCents: 2550,
      customerPhone: "912345678",
      countryCode: "351",
      customerEmail: "cliente@example.test",
      fetchImpl,
    });

    expect(calls[0].url).toBe("https://sandbox.eupago.pt/api/v1.02/mbway/create");
    expect(calls[0].headers).toMatchObject({ Authorization: "ApiKey dummy-api-key" });
    expect(calls[0].body).toMatchObject({
      payment: {
        identifier: IDENTIFIER,
        amount: { value: "25.50", currency: "EUR" },
        countryCode: "351",
        customerPhone: "912345678",
      },
    });
    expect(result.kind).toBe("created");
  });

  it("MB WAY creation success means REQUEST CREATED, never paid", async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 201,
      body: { transactionStatus: "Success", transactionID: "TX-1", reference: "REF-1" },
    }));
    const result = await createMbwayRequest({
      config: CONFIG,
      identifier: IDENTIFIER,
      amountCents: 1000,
      customerPhone: "912345678",
      countryCode: "351",
      fetchImpl,
    });
    // The creation result carries no notion of settlement at all.
    expect(result).not.toHaveProperty("paid");
    expect(JSON.stringify(result)).not.toContain("Paid");
  });

  it("rejects a non-Success transactionStatus even on 2xx", async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: { transactionStatus: "Error", message: "invalid phone" },
    }));
    await expect(
      createMbwayRequest({
        config: CONFIG,
        identifier: IDENTIFIER,
        amountCents: 1000,
        customerPhone: "912345678",
        countryCode: "351",
        fetchImpl,
      })
    ).resolves.toMatchObject({ kind: "rejected" });
  });

  it("validates phone/country before contacting the provider", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 201, body: {} }));
    await expect(
      createMbwayRequest({
        config: CONFIG,
        identifier: IDENTIFIER,
        amountCents: 1000,
        customerPhone: "not-a-phone",
        countryCode: "351",
        fetchImpl,
      })
    ).rejects.toThrow(ProviderError);
    expect(calls).toHaveLength(0);
  });
});

describe("B.3.2 — Credit Card creation (hosted, PCI-safe)", () => {
  const cardInput = {
    config: CONFIG,
    identifier: IDENTIFIER,
    amountCents: 5000,
    successUrl: "https://loja.mdtech.pt/checkout/sucesso",
    failUrl: "https://loja.mdtech.pt/checkout/falha",
    backUrl: "https://loja.mdtech.pt/checkout",
    customerEmail: "cliente@example.test",
  };

  it("returns an Eupago-hosted redirect URL", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 201,
      body: {
        transactionStatus: "Success",
        transactionID: "TX-9",
        reference: "REF-9",
        redirectUrl: "https://sandbox.eupago.pt/hosted/pay/abc123",
      },
    }));

    const result = await createCardRequest({ ...cardInput, fetchImpl });
    expect(calls[0].url).toBe("https://sandbox.eupago.pt/api/v1.02/creditcard/create");
    expect(calls[0].headers).toMatchObject({ Authorization: "ApiKey dummy-api-key" });
    expect(result.kind).toBe("created");
    if (result.kind === "created") {
      expect(isEupagoHostedUrl(result.redirectUrl!)).toBe(true);
    }
  });

  it("never sends or accepts PAN / CVV / expiry / OTP fields", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 201,
      body: {
        transactionStatus: "Success",
        reference: "REF-9",
        redirectUrl: "https://sandbox.eupago.pt/hosted/pay/abc123",
        // Even if a provider echoed card data, it must not survive normalization.
        pan: "4111111111111111",
        cvv: "123",
      },
    }));

    const result = await createCardRequest({ ...cardInput, fetchImpl });
    const requestBody = JSON.stringify(calls[0].body).toLowerCase();
    for (const forbidden of ["pan", "cardnumber", "card_number", "cvv", "cvc", "expiry", "otp", "3ds"]) {
      expect(requestBody).not.toContain(forbidden);
    }
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized).not.toContain("cvv");
  });

  it("rejects a redirect URL that is not Eupago-hosted", async () => {
    for (const evil of [
      "https://evil.test/pay",
      "https://evil.example/?x=clientes.eupago.pt",
      "https://clientes.eupago.pt.evil.example/",
      "https://clientes.eupago.pt@evil.example/pay",
      "https://evil.example@clientes.eupago.pt/pay",
      "https://clientes.eupago.pt:444/pay",
      "http://sandbox.eupago.pt/pay",
      "https://sandbox.eupago.pt.evil.test/pay",
      "not-a-url",
    ]) {
      const { fetchImpl } = stubFetch(() => ({
        status: 201,
        body: { transactionStatus: "Success", reference: "R", redirectUrl: evil },
      }));
      await expect(createCardRequest({ ...cardInput, fetchImpl })).resolves.toMatchObject({
        kind: "rejected",
        code: "INVALID_REDIRECT_URL",
      });
      expect(isEupagoHostedUrl(evil)).toBe(false);
    }
  });

  it("rejects a success response with no redirect URL", async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 201,
      body: { transactionStatus: "Success", reference: "REF-9" },
    }));
    await expect(createCardRequest({ ...cardInput, fetchImpl })).resolves.toMatchObject({
      kind: "rejected",
      code: "INVALID_REDIRECT_URL",
    });
  });
});

describe("B.3.2 — OAuth token handling", () => {
  it("uses the documented client_credentials body and never leaks the secret", async () => {
    clearEupagoTokenCache();
    const { fetchImpl, calls } = stubFetch(() => tokenResponse());
    const result = await getEupagoAccessToken({
      environment: "sandbox",
      clientId: CONFIG.oauthClientId,
      clientSecret: CONFIG.oauthClientSecret,
      fetchImpl,
    });
    expect(result).toMatchObject({ kind: "ok", accessToken: "dummy-token" });
    expect(calls[0].url).toBe("https://sandbox.eupago.pt/api/auth/token");
    expect(calls[0].body).toMatchObject({ grant_type: "client_credentials" });
    // The token is returned to the caller but never rendered into an error.
    expect(JSON.stringify(result)).not.toContain(CONFIG.oauthClientSecret);
  });

  it("reports OAuth failures as ambiguous (never as success)", async () => {
    clearEupagoTokenCache();
    const { fetchImpl } = stubFetch(() => ({ status: 401, body: { error: "invalid_client" } }));
    await expect(
      getEupagoAccessToken({
        environment: "sandbox",
        clientId: "x",
        clientSecret: "y",
        fetchImpl,
      })
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "oauth_failure" });
  });
});

describe("B.3.2 — recovery lookup absence semantics", () => {
  it("finds an existing creation by stable identifier", async () => {
    clearEupagoTokenCache();
    const { fetchImpl, calls } = stubFetch((c) =>
      c.url.includes("/auth/token")
        ? tokenResponse()
        : {
            status: 200,
            body: { data: [{ reference: "123456789", trid: "T-77", status: "Paid", amount: "12.34" }] },
          }
    );

    const result = await lookupByIdentifier({ config: CONFIG, identifier: IDENTIFIER, fetchImpl });
    expect(result).toMatchObject({ kind: "found", reference: "123456789", transactionId: "T-77" });
    const lookupCall = calls.find((c) => c.url.includes("references/info"))!;
    expect(lookupCall.url).toContain(`identifier=${IDENTIFIER}`);
    expect(lookupCall.headers).toMatchObject({ Authorization: "Bearer dummy-token" });
  });

  it("returns ABSENT only on a well-formed empty result or documented 404", async () => {
    clearEupagoTokenCache();
    const empty = stubFetch((c) =>
      c.url.includes("/auth/token") ? tokenResponse() : { status: 200, body: { data: [] } }
    );
    await expect(
      lookupByIdentifier({ config: CONFIG, identifier: IDENTIFIER, fetchImpl: empty.fetchImpl })
    ).resolves.toMatchObject({ kind: "absent" });

    clearEupagoTokenCache();
    const notFound = stubFetch((c) =>
      c.url.includes("/auth/token") ? tokenResponse() : { status: 404, body: { message: "not found" } }
    );
    await expect(
      lookupByIdentifier({ config: CONFIG, identifier: IDENTIFIER, fetchImpl: notFound.fetchImpl })
    ).resolves.toMatchObject({ kind: "absent" });
  });

  it("NEVER interprets timeout / 5xx / OAuth failure / malformed body as absent", async () => {
    // 5xx
    clearEupagoTokenCache();
    const serverError = stubFetch((c) =>
      c.url.includes("/auth/token") ? tokenResponse() : { status: 500, body: {} }
    );
    await expect(
      lookupByIdentifier({ config: CONFIG, identifier: IDENTIFIER, fetchImpl: serverError.fetchImpl })
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "server_error" });

    // timeout
    clearEupagoTokenCache();
    const timeoutFetch = (async (url: string) => {
      if (String(url).includes("/auth/token")) {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 300 }), { status: 200 });
      }
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    await expect(
      lookupByIdentifier({ config: CONFIG, identifier: IDENTIFIER, fetchImpl: timeoutFetch })
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "timeout" });

    // OAuth failure
    clearEupagoTokenCache();
    const oauthFail = stubFetch(() => ({ status: 401, body: { error: "invalid_client" } }));
    await expect(
      lookupByIdentifier({ config: CONFIG, identifier: IDENTIFIER, fetchImpl: oauthFail.fetchImpl })
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "oauth_failure" });

    // malformed / unexpected shape
    clearEupagoTokenCache();
    const malformed = stubFetch((c) =>
      c.url.includes("/auth/token") ? tokenResponse() : { status: 200, body: { unexpected: true } }
    );
    await expect(
      lookupByIdentifier({ config: CONFIG, identifier: IDENTIFIER, fetchImpl: malformed.fetchImpl })
    ).resolves.toMatchObject({ kind: "ambiguous", reason: "malformed_response" });

    // authorization problem is NOT proof of absence
    clearEupagoTokenCache();
    const forbidden = stubFetch((c) =>
      c.url.includes("/auth/token") ? tokenResponse() : { status: 403, body: {} }
    );
    await expect(
      lookupByIdentifier({ config: CONFIG, identifier: IDENTIFIER, fetchImpl: forbidden.fetchImpl })
    ).resolves.toMatchObject({ kind: "ambiguous" });
  });
});
