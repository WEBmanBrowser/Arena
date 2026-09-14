/**
 * C.3.4.4 — GRUPO B: gate do pricelist REAL (6 colunas, semântica desconhecida).
 *
 * O /pricelist-1.txt atual é TAB com 6 colunas, sem header, sem quotes — e a
 * semântica NÃO é conhecida. Trava:
 *  - ficheiro TODO com 6 colunas → UNSUPPORTED_ALSO_PRICELIST_FORMAT (falha o
 *    ficheiro, zero linhas, zero apply) — NUNCA artefactos INVALID_GTIN /
 *    INVALID_STOCK / INVALID_COST do parser posicional de 10 colunas;
 *  - o gate corre no parser E no dispatcher (formato explícito also_pricelist);
 *  - compat: ficheiro legado de 10 colunas continua a parsear (por linha);
 *  - uma linha curta isolada num ficheiro de 10 não dispara o gate.
 */
import { describe, expect, it } from "vitest";
import { ALSO_REAL_PRICELIST_COLUMNS, parseAlsoPricelist } from "@/lib/supplier-import/also";
import { SupplierCsvError } from "@/lib/supplier-import/normalize";
import { parseSupplierFile } from "@/lib/supplier-import/file";

const REAL_LINE = "1.520\t\t\t0\t0\t"; // 6 colunas, semântica desconhecida
const REAL_QUOTED = '"1.520"\t""\t""\t"0"\t"0"\t""';

function legacyLine(id: string): string {
  return [id, "5901234123457", "Cat1", "Cat2", "Cat3", "Produto Teste", "5", "12,50", "MPN-001", "BrandX"].join("\t");
}

describe("C.3.4.4 [B] — pricelist REAL de 6 colunas é rejeitado explicitamente", () => {
  it("constante do gate = 6", () => {
    expect(ALSO_REAL_PRICELIST_COLUMNS).toBe(6);
  });

  it("todas as linhas com 6 colunas → UNSUPPORTED_ALSO_PRICELIST_FORMAT", () => {
    const txt = [REAL_LINE, REAL_LINE, REAL_LINE].join("\n");
    expect(() => parseAlsoPricelist(txt)).toThrowError(/UNSUPPORTED_ALSO_PRICELIST_FORMAT/);
  });

  it("uma só linha de 6 colunas também dispara o gate", () => {
    expect(() => parseAlsoPricelist(REAL_LINE)).toThrowError(/UNSUPPORTED_ALSO_PRICELIST_FORMAT/);
  });

  it("versão com quotes de transporte também dispara (conta células, não aspas)", () => {
    expect(() => parseAlsoPricelist([REAL_QUOTED, REAL_QUOTED].join("\n"))).toThrowError(
      /UNSUPPORTED_ALSO_PRICELIST_FORMAT/
    );
  });

  it("o erro é de FICHEIRO (SupplierCsvError): zero linhas, zero INVALID_* por linha", () => {
    let caught: unknown = null;
    try {
      parseAlsoPricelist([REAL_LINE, REAL_LINE].join("\r\n"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SupplierCsvError);
    expect((caught as SupplierCsvError).code).toBe("UNSUPPORTED_ALSO_PRICELIST_FORMAT");
  });

  it("dispatcher com formato explícito also_pricelist → mesmo gate", () => {
    expect(() => parseSupplierFile([REAL_LINE, REAL_LINE].join("\n"), undefined, "also_pricelist")).toThrowError(
      /UNSUPPORTED_ALSO_PRICELIST_FORMAT/
    );
  });
});

describe("C.3.4.4 [B] — compat: 10 colunas legado + linha curta isolada", () => {
  it("ficheiro legado de 10 colunas continua a parsear", () => {
    const parsed = parseAlsoPricelist([legacyLine("PID1"), legacyLine("PID2")].join("\n"));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].supplierSku).toBe("PID1");
  });

  it("linha curta isolada num ficheiro de 10 → comportamento por-linha (sem gate)", () => {
    const parsed = parseAlsoPricelist([legacyLine("PID1"), "SHORT\tLINE", legacyLine("PID2")].join("\n"));
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0].supplierSku).toBe("PID1");
    expect(parsed.rows[2].supplierSku).toBe("PID2");
  });
});
