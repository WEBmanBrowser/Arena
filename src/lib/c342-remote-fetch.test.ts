/**
 * C.3.4.2 — fetchSource remoto: testes Puros (sem BD, sem rede real).
 *
 * O fetch recebe um `fetchImpl` injetado (padrão do cliente Eupago). Cobrem-
 * se aqui as quatro famílias de regras aprovadas para esta fase:
 *  - URL/SSRF + política de redirect (manual, ≤3, revalidação total, same-host);
 *  - streaming com teto de 5 MB (Content-Length antes; bytes reais durante);
 *  - autenticação none/basic/bearer/header via secret_reference, com o
 *    segredo NUNCA visível em erros;
 *  - política de estados HTTP (retry só em timeout/rede/429/502/503/504,
 *    Retry-After razoável, 304 condicionado) e deteção de formato pelos
 *    bytes (Content-Type é decorativo).
 */
import { describe, it, expect, vi } from "vitest";
import {
  SOURCE_FETCH_TIMEOUT_MS,
  SOURCE_MAX_CONTENT_BYTES,
  SourceFetchError,
  SupplierSourceError,
  buildSourceRequestHeaders,
  fetchSource,
  readBodyCapped,
  resolveSourceSecret,
  type RemoteSourceConfig,
} from "@/lib/supplier-import/source";

const URL_OK = "https://supplier.example.com/files/lista.csv";
const CSV_BODY = "skuFornecedor;nome;custo;stock;ean\nC342-A;Produto A;10,00;5;5901234123457";

// ─── Infra de mocking do transporte ──────────────────────

interface FakeResponse {
  status: number;
  headers: Headers;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
}

interface CallRecord {
  url: string;
  init: { method?: string; redirect?: string; headers?: Record<string, string>; signal?: AbortSignal };
}

function fakeResponse(
  status: number,
  opts: { headers?: Record<string, string>; bodyBytes?: Uint8Array; noBody?: boolean } = {}
): FakeResponse {
  const headers = new Headers(opts.headers ?? {});
  if (opts.bodyBytes && !headers.has("content-length")) {
    headers.set("content-length", String(opts.bodyBytes.byteLength));
  }
  const body = opts.bodyBytes
    ? streamOf([{ value: opts.bodyBytes }])
    : opts.noBody
      ? null
      : streamOf([]);
  return { status, headers, body };
}

/**
 * Body controlável com a forma de `ReadableStream` mínima (getReader +
 * cancel ao nível do body, como um Response real): a primitiva de leitura usa
 * `reader.cancel()`; o drain de redirects/Content-Length usa `body.cancel()`.
 */
function streamOf(chunks: Array<{ value?: Uint8Array; error?: unknown }>, tracker?: { reads: number; cancels: number }) {
  let i = 0;
  let cancelled = false;
  const body = {
    getReader() {
      return {
        async read() {
          if (tracker) tracker.reads += 1;
          if (cancelled) return { done: true as const, value: undefined };
          const chunk = chunks[i++];
          if (!chunk) return { done: true as const, value: undefined };
          if (chunk.error !== undefined) throw chunk.error;
          return { done: false as const, value: chunk.value };
        },
        async cancel() {
          cancelled = true;
          if (tracker) tracker.cancels += 1;
        },
      };
    },
    async cancel() {
      cancelled = true;
      if (tracker) tracker.cancels += 1;
    },
  };
  return body;
}

function streamChunks(pieces: Uint8Array[], tracker?: { reads: number; cancels: number }) {
  return streamOf(pieces.map((value) => ({ value })), tracker);
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

type Responder = (url: string, call: number) => FakeResponse | Error;

function mockFetch(responder: Responder) {
  const calls: CallRecord[] = [];
  const fetchImpl = (async (input: unknown, init: unknown) => {
    const record: CallRecord = { url: String(input), init: (init ?? {}) as CallRecord["init"] };
    calls.push(record);
    const result = responder(record.url, calls.length - 1);
    if (result instanceof Error) throw result;
    return result as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const baseCfg = (over: Partial<RemoteSourceConfig> = {}): RemoteSourceConfig => ({
  url: URL_OK,
  format: "csv",
  authType: "none",
  ...over,
});

const fetchWith = (cfg: Partial<RemoteSourceConfig>, responder: Responder, opts = {}) => {
  const { fetchImpl, calls } = mockFetch(responder);
  return {
    run: fetchSource(baseCfg(cfg), {
      fetchImpl,
      env: {},
      sleepImpl: async () => {},
      ...opts,
    }),
    calls,
  };
};

const expectCode = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toBeInstanceOf(SupplierSourceError);
  await expect(promise).rejects.toMatchObject({ code });
};

// ─── 1. URL/SSRF (as guardas puras fecham ANTES de qualquer rede) ─────────

describe("C.3.4.2 — fetchSource: URL/SSRF antes do I/O", () => {
  it("HTTPS público válido: GET com redirect manual e sem credenciais no pedido", async () => {
    const { run, calls } = fetchWith({}, () => fakeResponse(200, { bodyBytes: bytesOf(CSV_BODY) }));
    const result = await run;
    expect(result.kind).toBe("content");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_OK);
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers?.authorization).toBeUndefined();
    expect(calls[0].init.headers?.["accept-encoding"]).toBe("identity");
  });

  it("HTTP (não-HTTPS) é rejeitado SEM qualquer chamada de rede", async () => {
    const { run, calls } = fetchWith({ url: "http://supplier.example.com/x.csv" }, () => fakeResponse(200));
    await expectCode(run, "SOURCE_URL_SCHEME");
    expect(calls).toHaveLength(0);
  });

  it("userinfo, IP literal e localhost são rejeitados antes do fetch", async () => {
    for (const [url, code] of [
      ["https://user:pass@supplier.example.com/x.csv", "SOURCE_URL_CREDENTIALS"],
      ["https://127.0.0.1/x.csv", "SOURCE_URL_PRIVATE_IP"],
      ["https://10.13.37.5/x.csv", "SOURCE_URL_PRIVATE_IP"],
      ["https://169.254.169.254/latest/meta-data", "SOURCE_URL_PRIVATE_IP"],
      ["https://localhost/x.csv", "SOURCE_URL_LOCAL_HOST"],
      ["https://[::1]/x.csv", "SOURCE_URL_PRIVATE_IP"],
      ["https://2130706433/x.csv", "SOURCE_URL_PRIVATE_IP"],
    ] as const) {
      const { run, calls } = fetchWith({ url }, () => fakeResponse(200));
      await expectCode(run, code);
      expect(calls).toHaveLength(0);
    }
  });

  it("C.3.4.2 fix — URL inicial com query é REJEITADA (fail-closed), com zero chamadas de rede", async () => {
    for (const url of [
      "https://supplier.example.com/files/lista.csv?token=abc",
      "https://supplier.example.com/files/lista.csv?x=1",
    ]) {
      const { run, calls } = fetchWith({ url }, () => fakeResponse(200, { bodyBytes: bytesOf(CSV_BODY) }));
      await expectCode(run, "SOURCE_URL_QUERY_NOT_ALLOWED");
      expect(calls).toHaveLength(0); // recusado ANTES de qualquer rede — não se remove a query para continuar
    }
  });

  it("C.3.4.2 fix — URL inicial com #fragment é rejeitada", async () => {
    const { run, calls } = fetchWith({ url: "https://supplier.example.com/files/lista.csv#top" }, () => fakeResponse(200));
    await expectCode(run, "SOURCE_URL_FRAGMENT_NOT_ALLOWED");
    expect(calls).toHaveLength(0);
  });

  it("C.3.4.2 fix — o erro nunca contém o URL nem o valor do token da query", async () => {
    const { run } = fetchWith({ url: "https://supplier.example.com/feed.csv?token=SU-PER-SEKRET" }, () => fakeResponse(200));
    let caught: unknown;
    try {
      await run;
      throw new Error("expected rejection");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SourceFetchError);
    const err = caught as SourceFetchError & { url?: unknown };
    expect(err.code).toBe("SOURCE_URL_QUERY_NOT_ALLOWED");
    expect(err.httpStatus).toBe(400);
    const serialized = JSON.stringify({ message: err.message, code: err.code, url: err.url, stack: String(err.stack ?? "") });
    expect(serialized).not.toContain("SU-PER-SEKRET");
    expect(serialized).not.toContain("supplier.example.com");
  });
});

// ─── 2. Política de REDIRECT (manual, ≤3, revalidado, same-host) ─────────

describe("C.3.4.2 — política de redirect", () => {
  it("redirect same-host (relativo) é seguido até 200 — Location NUNCA automático", async () => {
    const { run, calls } = fetchWith({}, (url, n) =>
      n === 0
        ? fakeResponse(302, { headers: { location: "/files/lista-v2.csv" }, noBody: true })
        : fakeResponse(200, { bodyBytes: bytesOf(CSV_BODY) })
    );
    const result = await run;
    expect(result.kind).toBe("content");
    expect(calls.map((c) => c.url)).toEqual([URL_OK, "https://supplier.example.com/files/lista-v2.csv"]);
    expect(calls[1].init.redirect).toBe("manual");
  });

  it("redirect cross-host é BLOQUEADO (host policy sem wildcards)", async () => {
    const { run, calls } = fetchWith({}, () => fakeResponse(301, { headers: { location: "https://evil-other-host.com/x.csv" }, noBody: true }));
    await expectCode(run, "SOURCE_REDIRECT_BLOCKED");
    expect(calls).toHaveLength(1); // o Location foi bloqueado, não seguido
  });

  it("redirect para localhost/http/IP também é bloqueado (revalidação total)", async () => {
    for (const [location, code] of [
      ["https://localhost/x.csv", "SOURCE_URL_LOCAL_HOST"],
      ["http://supplier.example.com/x.csv", "SOURCE_URL_SCHEME"],
      ["https://127.0.0.1/x.csv", "SOURCE_URL_PRIVATE_IP"],
      ["https://other:pw@supplier.example.com/x.csv", "SOURCE_URL_CREDENTIALS"],
    ] as const) {
      const { run } = fetchWith({}, () => fakeResponse(302, { headers: { location }, noBody: true }));
      await expectCode(run, code);
    }
  });

  it("máximo de 3 redirects: o 4.º Location é rejeitado (SOURCE_REDIRECT_BLOCKED)", async () => {
    const { run, calls } = fetchWith({}, (_url, n) =>
      n < 3
        ? fakeResponse(302, { headers: { location: `/hop/${n + 1}` }, noBody: true })
        : fakeResponse(302, { headers: { location: "/hop/4" }, noBody: true })
    );
    await expectCode(run, "SOURCE_REDIRECT_BLOCKED");
    expect(calls).toHaveLength(4); // original + 3 seguidos; o 4.º Location é recusado
  });

  it("redirect sem Location falha com erro seguro", async () => {
    const { run } = fetchWith({}, () => fakeResponse(307, { noBody: true }));
    await expectCode(run, "SOURCE_REDIRECT_BLOCKED");
  });

  it("C.3.4.2 fix — redirect same-host para URL COM QUERY: rejeitado ANTES do próximo fetch", async () => {
    const { run, calls } = fetchWith({}, (_url, n) =>
      n === 0
        ? fakeResponse(302, { headers: { location: "/files/lista.csv?token=abc" }, noBody: true })
        : fakeResponse(200, { bodyBytes: bytesOf(CSV_BODY) })
    );
    await expectCode(run, "SOURCE_URL_QUERY_NOT_ALLOWED");
    expect(calls).toHaveLength(1); // o Location foi recusado; nenhum segundo pedido saiu
  });

  it("C.3.4.2 fix — redirect same-host para URL COM FRAGMENT: rejeitado, zero follow-up", async () => {
    const { run, calls } = fetchWith({}, () =>
      fakeResponse(302, { headers: { location: "https://supplier.example.com/files/lista.csv#top" }, noBody: true })
    );
    await expectCode(run, "SOURCE_URL_FRAGMENT_NOT_ALLOWED");
    expect(calls).toHaveLength(1);
  });
});

// ─── 3. Streaming limitado a 5 MB ────────────────────────

describe("C.3.4.2 — leitura em streaming com teto", () => {
  const MAX = SOURCE_MAX_CONTENT_BYTES;

  it("Content-Length > 5 MB: rejeita ANTES de ler um byte do corpo", async () => {
    const tracker = { reads: 0, cancels: 0 };
    const { run } = fetchWith({}, () => {
      const headers = new Headers({ "content-length": String(MAX + 1) });
      const body = streamOf([{ value: new Uint8Array(16) }], tracker);
      return { status: 200, headers, body } as unknown as FakeResponse;
    });
    await expectCode(run, "SOURCE_TOO_LARGE");
    expect(tracker.reads).toBe(0); // o corpo nunca foi lido
  });

  it("sem Content-Length: interrompe ASSIM que passa 5 MB e cancela o leitor", async () => {
    const tracker = { reads: 0, cancels: 0 };
    const big = new Uint8Array(MAX / 2); // 2.5 MB por chunk
    const { run } = fetchWith({}, (_url, n) => {
      void n;
      const headers = new Headers(); // sem content-length
      const body = streamChunks([big, big, big], tracker);
      return { status: 200, headers, body } as unknown as FakeResponse;
    });
    await expectCode(run, "SOURCE_TOO_LARGE");
    expect(tracker.reads).toBe(3); // parou no 3.º chunk (7.5 MB > teto), nunca leu tudo
    expect(tracker.cancels).toBe(1);
  });

  it("< 5 MB: aceita e preserva os BYTES EXATOS (hash/parse do que foi recebido)", async () => {
    const tracker = { reads: 0, cancels: 0 };
    const half = bytesOf(CSV_BODY);
    const { run } = fetchWith({}, () => {
      const headers = new Headers();
      return { status: 200, headers, body: streamChunks([half], tracker) } as unknown as FakeResponse;
    });
    const result = await run;
    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(result.payload.text).toBe(CSV_BODY);
    }
    expect(tracker.cancels).toBe(0);
  });

  it("readBodyCapped é a primitiva partilhada: teto + cancel explícitos", async () => {
    const tracker = { reads: 0, cancels: 0 };
    const source = { status: 200, headers: new Headers(), body: streamChunks([new Uint8Array(10), new Uint8Array(10)], tracker) };
    await expect(readBodyCapped(source, 15)).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
    expect(tracker.cancels).toBe(1);
    const okSource = { status: 200, headers: new Headers(), body: streamChunks([new Uint8Array([1, 2, 3])]) };
    expect((await readBodyCapped(okSource, 15)).byteLength).toBe(3);
  });
});

// ─── 4. Autenticação (none/basic/bearer/header, só referência) ───────────

describe("C.3.4.2 — autenticação via secret_reference", () => {
  const SECRET = "t0p-s3cr3t-v4lue";

  it("none: nenhum Authorization mesmo com segredo disponível", () => {
    const headers = buildSourceRequestHeaders(baseCfg({ authType: "none" }), { SUPPLIER_SECRET: SECRET });
    expect(headers.authorization).toBeUndefined();
  });

  it("basic: username da BD + password do env, em base64 canónico", () => {
    const headers = buildSourceRequestHeaders(
      { url: URL_OK, format: "csv", authType: "basic", username: "ftpuser", secretReference: "SUPPLIER_SECRET" },
      { SUPPLIER_SECRET: "pw123" }
    );
    expect(headers.authorization).toBe(`Basic ${Buffer.from("ftpuser:pw123").toString("base64")}`);
  });

  it("bearer: 'Authorization: Bearer <secret>' resolvido só no runtime", () => {
    const headers = buildSourceRequestHeaders(
      { url: URL_OK, format: "csv", authType: "bearer", secretReference: "SUPPLIER_SECRET" },
      { SUPPLIER_SECRET: SECRET }
    );
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it("header: o nome vem de headers_config (não-secreto); o valor só do secret", () => {
    const headers = buildSourceRequestHeaders(
      {
        url: URL_OK,
        format: "csv",
        authType: "header",
        secretReference: "SUPPLIER_SECRET",
        headersConfig: { headerName: "X-Api-Key", "x-tenant": "acme" },
      },
      { SUPPLIER_SECRET: SECRET }
    );
    expect(headers["X-Api-Key"]).toBe(SECRET);
    expect(headers["x-tenant"]).toBe("acme");
    // headerName é config reservada — nunca viaja como header literal.
    expect(headers.headerName).toBeUndefined();
  });

  it("secret ausente (sem referência OU env sem o nome): SOURCE_AUTH_SECRET_MISSING, sem rede", async () => {
    for (const auth of ["basic", "bearer", "header"] as const) {
      const missing = fetchWith({ authType: auth, username: "u", secretReference: "NOT_SET_ENV", headersConfig: { headerName: "X-Key" } }, () => fakeResponse(200));
      await expectCode(missing.run, "SOURCE_AUTH_SECRET_MISSING");
      expect(missing.calls).toHaveLength(0);
      const noRef = fetchWith({ authType: auth, username: "u" }, () => fakeResponse(200));
      await expectCode(noRef.run, "SOURCE_AUTH_SECRET_MISSING");
      expect(noRef.calls).toHaveLength(0);
    }
  });

  it("resolveSourceSecret exige nome de env canónico e valor limpo (sem CRLF)", () => {
    expect(() => resolveSourceSecret("lower_case", {})).toThrowError(SupplierSourceError);
    expect(() => resolveSourceSecret("WITH\r\nINJECTION", { A: "b" })).toThrowError(SupplierSourceError);
    expect(() => resolveSourceSecret("NAME", { NAME: "bad\rvalue" })).toThrowError(SupplierSourceError);
    expect(resolveSourceSecret("NAME", { NAME: "ok" })).toBe("ok");
  });

  it("o segredo NUNCA aparece em erros/logados nem em stacks", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = fetchWith(
      { authType: "bearer", secretReference: "SUPPLIER_SECRET" },
      () => fakeResponse(500, { noBody: true }),
      { env: { SUPPLIER_SECRET: SECRET } }
    );
    let caught: unknown;
    try {
      await run;
      throw new Error("expected rejection");
    } catch (e) {
      caught = e;
    }
    const text = `${String(caught)} ${(caught as Error).message} ${(caught as Error).stack}`;
    expect(caught).toBeInstanceOf(SourceFetchError);
    expect((caught as SourceFetchError).code).toBe("SOURCE_HTTP_5XX");
    expect(text).not.toContain(SECRET);
    for (const call of logSpy.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
    logSpy.mockRestore();
  });
});

// ─── 5. ETag / Last-Modified condicionais + 304 ─────────

describe("C.3.4.2 — validadores HTTP", () => {
  it("sem validadores guardados: pedido SEM If-None-Match/If-Modified-Since", async () => {
    const { run, calls } = fetchWith({}, () => fakeResponse(200, { bodyBytes: bytesOf(CSV_BODY) }));
    await run;
    expect(calls[0].init.headers?.["if-none-match"]).toBeUndefined();
    expect(calls[0].init.headers?.["if-modified-since"]).toBeUndefined();
  });

  it("com last_etag/last_modified: envia If-None-Match e If-Modified-Since", async () => {
    const { run, calls } = fetchWith(
      { lastEtag: '"v7"', lastModified: "Mon, 07 Sep 2026 10:00:00 GMT" },
      () => fakeResponse(304, { noBody: true })
    );
    const result = await run;
    expect(calls[0].init.headers?.["if-none-match"]).toBe('"v7"');
    expect(calls[0].init.headers?.["if-modified-since"]).toBe("Mon, 07 Sep 2026 10:00:00 GMT");
    expect(result).toEqual({ kind: "not_modified", httpStatus: 304 });
  });

  it("200 guarda ETag/Last-Modified da resposta no payload/transporte", async () => {
    const { run } = fetchWith(
      { format: "auto" },
      () => fakeResponse(200, { headers: { etag: '"new-etag"', "last-modified": "Tue, 08 Sep 2026 08:00:00 GMT" }, bodyBytes: bytesOf(CSV_BODY) })
    );
    const result = await run;
    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(result.etag).toBe('"new-etag"');
      expect(result.lastModified).toBe("Tue, 08 Sep 2026 08:00:00 GMT");
      expect(result.payload.etag).toBe('"new-etag"');
    }
  });
});

// ─── 6. Estados HTTP + retries ───────────────────────────

describe("C.3.4.2 — política de estados e retries", () => {
  it.each([
    [400, "SOURCE_FETCH_FAILED"],
    [401, "SOURCE_HTTP_401"],
    [403, "SOURCE_HTTP_403"],
    [404, "SOURCE_HTTP_404"],
    [418, "SOURCE_FETCH_FAILED"],
    [500, "SOURCE_HTTP_5XX"],
    [501, "SOURCE_HTTP_5XX"],
  ])("sem retry em HTTP %i (1 tentativa, código seguro %s)", async (status, code) => {
    const { run, calls } = fetchWith({}, () => fakeResponse(status, { noBody: true }));
    await expectCode(run, code);
    expect(calls).toHaveLength(1);
  });

  it("429 com Retry-After razoável: volta a tentar e depois succeeds", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = mockFetch((_url, n) =>
      n === 0 ? fakeResponse(429, { headers: { "retry-after": "3" }, noBody: true }) : fakeResponse(200, { bodyBytes: bytesOf(CSV_BODY) })
    );
    const result = await fetchSource(baseCfg({}), {
      fetchImpl,
      env: {},
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.kind).toBe("content");
    expect(sleeps).toEqual([3000]); // Retry-After: 3s, respeitado
    expect(calls).toHaveLength(2);
  });

  it("429 com Retry-After absurdo (1h): falha JÁ com SOURCE_HTTP_429", async () => {
    const { run, calls } = fetchWith({}, () => fakeResponse(429, { headers: { "retry-after": "3600" }, noBody: true }));
    await expectCode(run, "SOURCE_HTTP_429");
    expect(calls).toHaveLength(1);
  });

  it("502/503/504: retry até 3 tentativas TOTAL, depois SOURCE_HTTP_5XX", async () => {
    const { run, calls } = fetchWith({}, () => fakeResponse(503, { noBody: true }));
    await expectCode(run, "SOURCE_HTTP_5XX");
    expect(calls).toHaveLength(3); // máximo absoluto: 3 tentativas
  });

  it("timeout do fetch: AbortController dispara e esgota as 3 tentativas → SOURCE_FETCH_TIMEOUT", async () => {
    const hanging = (_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    const calls: unknown[] = [];
    const fetchImpl = ((url: unknown, init: unknown) => {
      calls.push({ url, init });
      return hanging(String(url), init as { signal?: AbortSignal });
    }) as unknown as typeof fetch;
    await expect(
      fetchSource(baseCfg({}), { fetchImpl, env: {}, timeoutMs: 10, maxAttempts: 3, sleepImpl: async () => {} })
    ).rejects.toMatchObject({ code: "SOURCE_FETCH_TIMEOUT" });
    expect(calls).toHaveLength(3);
    expect(SOURCE_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("erro de rede em todas as tentativas → SOURCE_FETCH_FAILED (nunca crash cru)", async () => {
    const { run, calls } = fetchWith({}, () => new TypeError("fetch failed"));
    await expectCode(run, "SOURCE_FETCH_FAILED");
    expect(calls).toHaveLength(3);
  });
});

// ─── 7. Formato: explícito vence; auto deteta bytes; Content-Type ignora-se

describe("C.3.4.2 — formato decidido pelo conteúdo", () => {
  it("auto + corpo PK\\x03\\x04 → XLSX (bytes exatos preservados)", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const { run } = fetchWith({ format: "auto" }, () => fakeResponse(200, { headers: { "content-type": "text/csv" }, bodyBytes: zip }));
    const result = await run;
    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(result.payload.format).toBe("xlsx");
      expect(result.payload.bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(result.payload.bytes!)).toEqual(Array.from(zip));
      expect(result.payload.text).toBeUndefined();
    }
  });

  it("auto + texto → CSV, mesmo com Content-Type a mentir", async () => {
    const { run } = fetchWith({ format: "auto" }, () => fakeResponse(200, { headers: { "content-type": "application/octet-stream" }, bodyBytes: bytesOf(CSV_BODY) }));
    const result = await run;
    if (result.kind === "content") {
      expect(result.payload.format).toBe("csv");
      expect(result.payload.text).toBe(CSV_BODY);
      // Content-Type é APENAS informativo — fica no payload, decide nada.
      expect(result.payload.contentType).toBe("application/octet-stream");
    } else throw new Error("expected content");
  });

  it("format explícito xlsx NÃO é desmentido por Content-Type nem pelo sniffing de texto", async () => {
    const weird = bytesOf("plain text mas o admin sabe que é xlsx");
    const { run } = fetchWith({ format: "xlsx" }, () => fakeResponse(200, { bodyBytes: weird }));
    const result = await run;
    if (result.kind === "content") {
      expect(result.payload.format).toBe("xlsx");
      expect(result.payload.bytes).toBeDefined();
      expect(result.payload.text).toBeUndefined();
    } else throw new Error("expected content");
  });
});

// ─── 8. Config não-secreta dos headers ───────────────────

describe("C.3.4.2 — headers_config não-secreta", () => {
  it("Authorization literal na config é recusado (o valor do segredo não vive na BD)", () => {
    expect(() =>
      buildSourceRequestHeaders({ url: URL_OK, format: "csv", authType: "none", headersConfig: { Authorization: "Bearer hacked" } }, {})
    ).toThrowError(/SOURCE_HEADERS_CONFIG_INVALID/);
    expect(() =>
      buildSourceRequestHeaders({ url: URL_OK, format: "csv", authType: "none", headersConfig: { cookie: "sid=1" } }, {})
    ).toThrowError(/SOURCE_HEADERS_CONFIG_INVALID/);
  });

  it("CRLF em valor de header é recusado (header injection)", () => {
    expect(() =>
      buildSourceRequestHeaders({ url: URL_OK, format: "csv", authType: "none", headersConfig: { "x-tag": "ok\r\nX-Evil: 1" } }, {})
    ).toThrowError(/SOURCE_HEADERS_CONFIG_INVALID/);
  });

  it("auth=header sem headerName válido é erro de config, nunca segredo implícito", () => {
    expect(() =>
      buildSourceRequestHeaders({ url: URL_OK, format: "csv", authType: "header", secretReference: "S", headersConfig: {} }, { S: "v" })
    ).toThrowError(/SOURCE_AUTH_CONFIG_INVALID/);
  });
});

// Sanity: o teto do fetch É o teto dos parsers (5 MB), single source of truth.
it("C.3.4.2 — limite de conteúdo coincide com o teto CSV/XLSX", async () => {
  const { CSV_MAX_SIZE } = await import("@/lib/csv");
  const { XLSX_MAX_SIZE_BYTES } = await import("@/lib/supplier-import/xlsx");
  expect(SOURCE_MAX_CONTENT_BYTES).toBe(5 * 1024 * 1024);
  expect(SOURCE_MAX_CONTENT_BYTES).toBe(CSV_MAX_SIZE);
  expect(SOURCE_MAX_CONTENT_BYTES).toBe(XLSX_MAX_SIZE_BYTES);
});
