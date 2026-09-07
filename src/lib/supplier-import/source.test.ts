/**
 * C.3.4.1 — Testes puros da abstração de FONTE (sem base de dados).
 *
 * Trava o contrato aprovado:
 *   SOURCE → SourcePayload → FORMATO → SupplierFileParse → NormalizedSupplierRow[]
 *
 *  - uploadSource() converte o upload CSV/XLSX exatamente como a rota;
 *  - assertSourcePayload() garante "exatamente um conteúdo";
 *  - sourceFormat/sourceByteLength/sourceSha256Hex são a ponte para o serviço;
 *  - guardSupplierSourceUrl() são guardas PURAS (sem DNS, sem rede).
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { createHash } from "crypto";
import {
  SOURCE_URL_GUARD_CODES,
  SupplierSourceError,
  assertSourcePayload,
  guardSupplierSourceUrl,
  isBlockedIpLiteral,
  isBlockedIpv4,
  isBlockedIpv6,
  isLocalHostname,
  looksLikeNumericHost,
  sourceByteLength,
  sourceFormat,
  sourceSha256Hex,
  uploadSource,
} from "@/lib/supplier-import/source";

function xlsxFixture(): Uint8Array {
  const ws: any = {};
  ws["A1"] = { t: "s", v: "sku" };
  ws["B1"] = { t: "s", v: "nome" };
  ws["A2"] = { t: "s", v: "REF-1" };
  ws["B2"] = { t: "s", v: "Produto" };
  ws["!ref"] = "A1:B2";
  return new Uint8Array(
    XLSX.write({ SheetNames: ["S"], Sheets: { S: ws } }, { type: "buffer", bookType: "xlsx" })
  );
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("C.3.4.1 — uploadSource (compatibilidade do upload CSV/XLSX)", () => {
  it("CSV/.txt → payload de texto com format csv e label = nome do ficheiro", () => {
    const p = uploadSource({ fileName: "lista.csv", csvText: "a;b\n1;2" });
    expect(p).toEqual({ kind: "upload", label: "lista.csv", format: "csv", text: "a;b\n1;2" });
    const txt = uploadSource({ fileName: "lista.TXT", csvText: "x" });
    expect(txt.format).toBe("csv");
    expect(txt.text).toBe("x");
  });

  it("XLSX → payload binário com os BYTES exatos (nunca texto/base64)", () => {
    const bytes = xlsxFixture();
    const p = uploadSource({ fileName: "lista.xlsx", xlsxBytes: bytes });
    expect(p.kind).toBe("upload");
    expect(p.format).toBe("xlsx");
    expect(p.bytes).toBe(bytes);
    expect(p.text).toBeUndefined();
  });

  it("XLSX sem bytes → XLSX_INVALID (nunca parsing parcial)", () => {
    expect(() => uploadSource({ fileName: "lista.xlsx" })).toThrowError(
      expect.objectContaining({ code: "XLSX_INVALID" })
    );
  });

  it("spreadsheet binário fora do escopo → FILE_TYPE_NOT_SUPPORTED", () => {
    for (const name of ["a.xls", "a.xlsm", "a.ods"]) {
      expect(() => uploadSource({ fileName: name, csvText: "x" })).toThrowError(
        expect.objectContaining({ code: "FILE_TYPE_NOT_SUPPORTED" })
      );
    }
  });

  it("nome vazio → label por omissão (nunca quebra o contrato)", () => {
    expect(uploadSource({ fileName: "", csvText: "a;b\n1;2" }).label).toBe("supplier-list.csv");
    expect(uploadSource({ fileName: "", xlsxBytes: xlsxFixture() }).label).toBe("supplier-list.xlsx");
  });
});

describe("C.3.4.1 — assertSourcePayload", () => {
  it("exatamente um conteúdo: texto OU bytes (vazio conta como inválido)", () => {
    expect(() => assertSourcePayload({ kind: "upload", label: "x.csv", format: "csv" })).toThrow(SupplierSourceError);
    expect(() =>
      assertSourcePayload({
        kind: "upload", label: "x.csv", format: "csv", text: "a", bytes: new Uint8Array([1]),
      })
    ).toThrow(SupplierSourceError);
    expect(() =>
      assertSourcePayload({ kind: "upload", label: "x", format: "xlsx", bytes: new Uint8Array(0) })
    ).toThrow(SupplierSourceError);
    expect(() =>
      assertSourcePayload({ kind: "upload", label: "x.csv", format: "csv", text: "" })
    ).not.toThrow(); // vazio → quem decide é o parser (CSV_EMPTY), não a fonte
    expect(() =>
      assertSourcePayload({ kind: "upload", label: "x.xlsx", format: "xlsx", bytes: new Uint8Array([1]) })
    ).not.toThrow();
  });

  it("label é obrigatório", () => {
    expect(() =>
      assertSourcePayload({ kind: "upload", label: " ", format: "csv", text: "a" })
    ).toThrow(SupplierSourceError);
  });
});

describe("C.3.4.1 — format/hash/tamanho (ponte para o serviço)", () => {
  it("format explícito vence sempre", () => {
    const p = uploadSource({ fileName: "lista.csv", csvText: "a;b\n1;2" });
    expect(sourceFormat(p)).toBe("csv");
    expect(sourceFormat({ kind: "url", label: "u", format: "xlsx" as const, bytes: new Uint8Array([1]) })).toBe("xlsx");
  });

  it('format "auto": ZIP/OOXML → xlsx; texto → csv', () => {
    const zip = { kind: "url" as const, label: "u", format: "auto" as const, bytes: xlsxFixture() };
    expect(sourceFormat(zip)).toBe("xlsx");
    const text = { kind: "url" as const, label: "u", format: "auto" as const, text: "a;b\n1;2" };
    expect(sourceFormat(text)).toBe("csv");
  });

  it("sourceByteLength: bytes reais; texto em UTF-8 (não caracteres)", () => {
    expect(sourceByteLength({ kind: "upload", label: "x", format: "csv", text: "aé" })).toBe(3);
    expect(sourceByteLength({ kind: "upload", label: "x", format: "xlsx", bytes: new Uint8Array([1, 2, 3]) })).toBe(3);
  });

  it("sourceSha256Hex: SHA-256 do conteúdo exato (bytes; UTF-8 do texto)", () => {
    const text = "skuFornecedor;nome\nR1;A";
    expect(sourceSha256Hex({ kind: "upload", label: "x.csv", format: "csv", text })).toBe(sha256Hex(text));
    const bytes = xlsxFixture();
    expect(
      sourceSha256Hex({ kind: "upload", label: "x.xlsx", format: "xlsx", bytes })
    ).toBe(createHash("sha256").update(Buffer.from(bytes)).digest("hex"));
  });
});

describe("C.3.4.1 — IP helpers puros", () => {
  it("isBlockedIpv4: privados/especiais/metadados bloqueados; públicos aceites", () => {
    for (const ip of [
      "0.0.0.0", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.100.100.200",
      "127.0.0.1", "127.255.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.0.0.1", "192.0.2.1", "192.168.0.1", "192.168.255.255", "198.18.0.1", "198.51.100.1",
      "203.0.113.1", "224.0.0.1", "255.255.255.255",
    ]) {
      expect(isBlockedIpv4(ip), ip).toBe(true);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "193.164.1.1"]) {
      expect(isBlockedIpv4(ip), ip).toBe(false);
    }
  });

  it("isBlockedIpv6: loopback/ULA/link-local/doc/embebido bloqueados", () => {
    for (const ip of [
      "::", "::1", "fc00::1", "fd12::1", "fe80::1", "fe80::abcd:1",
      "2001:db8::1", "::ffff:127.0.0.1", "::ffff:192.168.0.1", "::ffff:10.0.0.1",
      "::127.0.0.1",
    ]) {
      expect(isBlockedIpv6(ip), ip).toBe(true);
    }
    for (const ip of ["2606:4700::1111", "2001:4860:4860::8888"]) {
      expect(isBlockedIpv6(ip), ip).toBe(false);
    }
  });

  it("isBlockedIpLiteral cobre IPv4 e IPv6 (com e sem brackets)", () => {
    expect(isBlockedIpLiteral("127.0.0.1")).toBe(true);
    expect(isBlockedIpLiteral("[::1]")).toBe(true);
    expect(isBlockedIpLiteral("8.8.8.8")).toBe(false);
  });

  it("isLocalHostname: localhost/sufixos privados/metadados", () => {
    for (const h of [
      "localhost", "localhost.localdomain", "dev.local", "x.internal",
      "nas.home.arpa", "a.localdomain", "x.test", "y.invalid", "z.example", "tor.onion",
      "metadata", "metadata.google.internal", "instance-data.ec2.internal",
    ]) {
      expect(isLocalHostname(h), h).toBe(true);
    }
    for (const h of ["example.com", "supplier.example.com", "files.example-prices.com"]) {
      expect(isLocalHostname(h), h).toBe(false);
    }
  });

  it("looksLikeNumericHost: decimal/hex", () => {
    for (const h of ["2130706433", "0x7f000001", "127"]) {
      expect(looksLikeNumericHost(h), h).toBe(true);
    }
    expect(looksLikeNumericHost("example.com")).toBe(false);
  });
});

describe("C.3.4.1 — guardSupplierSourceUrl (guardas SSRF puras)", () => {
  it("HTTPS público válido: aceite (hostname devolvido normalizado)", () => {
    const r = guardSupplierSourceUrl("https://supplier.example.com/files/lista.csv");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hostname).toBe("supplier.example.com");
      expect(r.url.pathname).toBe("/files/lista.csv");
    }
    const withPort = guardSupplierSourceUrl("https://supplier.example.com:8443/x");
    expect(withPort.ok).toBe(true);
  });

  it("C.3.4.2 fail-closed: query e fragmento são PROIBIDOS (sem sanitização silenciosa)", () => {
    for (const [url, code] of [
      ["https://supplier.example.com/files/lista.csv?token=abc", "SOURCE_URL_QUERY_NOT_ALLOWED"],
      ["https://supplier.example.com/feed.csv?x=1", "SOURCE_URL_QUERY_NOT_ALLOWED"],
      ["https://supplier.example.com/feed.csv?a=1#frag", "SOURCE_URL_QUERY_NOT_ALLOWED"],
      ["https://supplier.example.com/feed.csv#top", "SOURCE_URL_FRAGMENT_NOT_ALLOWED"],
    ] as const) {
      const r = guardSupplierSourceUrl(url);
      expect(r.ok, url).toBe(false);
      if (!r.ok) {
        expect(r.code, url).toBe(code);
        // a mensagem é estática: NUNCA ecoa o URL nem o valor do parâmetro
        expect(r.message, url).not.toContain("abc");
        expect(r.message, url).not.toContain(url);
      }
    }
  });

  it("C.3.4.2: '?' ou '#' sem conteúdo NÃO carregam parâmetros (search/hash vazios) — aceites", () => {
    // Política é sobre DADOS (query/fragmento com conteúdo podem esconder
    // tokens); um "?" sem parâmetros não veicula nada — `url.search === ""`.
    const r = guardSupplierSourceUrl("https://supplier.example.com/feed.csv?");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.search).toBe("");
    const h = guardSupplierSourceUrl("https://supplier.example.com/feed.csv#");
    expect(h.ok).toBe(true);
    if (h.ok) expect(h.url.hash).toBe("");
  });

  it("HTTP é recusado por defeito; allowHttp é opt-in explícito", () => {
    const r = guardSupplierSourceUrl("http://supplier.example.com/x.csv");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SOURCE_URL_SCHEME");
    expect(guardSupplierSourceUrl("http://supplier.example.com/x.csv", { allowHttp: true }).ok).toBe(true);
  });

  it("URL malformada / demasiado longa", () => {
    expect(guardSupplierSourceUrl("").ok).toBe(false);
    expect(guardSupplierSourceUrl("not a url").ok).toBe(false);
    expect(guardSupplierSourceUrl("https://a.com/" + "x".repeat(3000)).ok).toBe(false);
  });

  it("credenciais na URL são proibidas", () => {
    const r = guardSupplierSourceUrl("https://user:pass@supplier.example.com/x.csv");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SOURCE_URL_CREDENTIALS");
  });

  it("IPs privados/especiais bloqueados (formas normalizadas incluídas)", () => {
    const blocked = [
      "https://127.0.0.1/x", "https://127.1/x", "https://2130706433/x", "https://0x7f000001/x",
      "https://10.0.0.1/x", "https://192.168.1.1/x", "https://172.16.0.1/x",
      "https://169.254.169.254/x", "https://100.100.100.200/x", "https://0.0.0.0/x",
      "https://[::1]/x", "https://[fe80::1]/x", "https://[fc00::1]/x",
      "https://[2001:db8::1]/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:192.168.0.1]/x",
    ];
    for (const u of blocked) {
      const r = guardSupplierSourceUrl(u);
      expect(r.ok, u).toBe(false);
      if (!r.ok) expect(r.code).toBe("SOURCE_URL_PRIVATE_IP");
    }
  });

  it("hostnames locais/metadados bloqueados", () => {
    for (const u of [
      "https://localhost/x", "https://metadata.google.internal/x", "https://dev.local/x",
      "https://x.internal/x", "https://foo.test/x",
    ]) {
      const r = guardSupplierSourceUrl(u);
      expect(r.ok, u).toBe(false);
      if (!r.ok) expect(r.code).toBe("SOURCE_URL_LOCAL_HOST");
    }
  });

  it("códigos de erro fazem parte do contrato estável", () => {
    expect(SOURCE_URL_GUARD_CODES).toContain("SOURCE_URL_PRIVATE_IP");
    expect(SOURCE_URL_GUARD_CODES).toContain("SOURCE_URL_LOCAL_HOST");
  });
});
