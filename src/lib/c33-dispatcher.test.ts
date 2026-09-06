/**
 * C.3.3 (etapa 1) — Dispatcher de formatos (puros, sem base de dados).
 *
 * Trava o contracto do refactor sem XLSX:
 *
 *  A) parseSupplierFile é a nova porta de entrada e, no ramo CSV, produz
 *     EXATAMENTE o mesmo resultado do parser original parseSupplierCsv
 *     (headers, delimiter, mapping, ignoredColumns, rows, erros);
 *  B) nesta etapa só existe o ramo "csv";
 *  C) resolveSupplierFileMapping mantém a semântica C.3.2 verbatim:
 *     manual não vazio > perfil compatível (re-parse) > fallback seguro;
 *     o re-parse só acontece quando o perfil é efetivamente aplicado;
 *  D) o fallback seguro devolve o MESMO objeto do parse inicial.
 */
import { describe, expect, it, vi } from "vitest";
import { parseSupplierCsv, SupplierCsvError } from "@/lib/supplier-import/normalize";
import {
  SUPPLIER_FILE_FORMATS,
  isProfileCompatibleWithHeaders,
  parseSupplierFile,
  resolveSupplierFileMapping,
} from "@/lib/supplier-import/file";

const CSV_PT = "\uFEFFskuFornecedor;nome;custo;stock;ean\nREF-001;\"Cabo HDMI; 2m\";10,00;8;5901234123457\nREF-002;Rato;1.234,56;0;\n";
const CSV_COMMA = "sku,name,cost,stock\nSKU-1,Widget,9.99,3\n";

describe("C.3.3 — parseSupplierFile (dispatcher)", () => {
  it("ramo CSV (formato por omissão) === parseSupplierCsv, byte a byte", () => {
    const viaDispatcher = parseSupplierFile(CSV_PT);
    const viaParser = parseSupplierCsv(CSV_PT);
    expect(viaDispatcher).toEqual(viaParser);
    expect(viaDispatcher.delimiter).toBe(";");
    expect(viaDispatcher.headers).toEqual(["skuFornecedor", "nome", "custo", "stock", "ean"]);
    expect(viaDispatcher.mapping).toEqual({
      skuFornecedor: "supplierSku",
      nome: "name",
      custo: "costPrice",
      stock: "stock",
      ean: "ean",
    });
  });

  it('formato explícito "csv" produz o mesmo resultado', () => {
    expect(parseSupplierFile(CSV_PT, undefined, "csv")).toEqual(parseSupplierCsv(CSV_PT));
  });

  it("CSV com vírgula e overrides manuais: mesma saída do parser original", () => {
    const overrides = { sku: "supplierSku", name: "name", cost: "costPrice", stock: "stock" };
    expect(parseSupplierFile(CSV_COMMA, overrides)).toEqual(parseSupplierCsv(CSV_COMMA, overrides));
    expect(parseSupplierFile(CSV_COMMA, overrides).mapping).toEqual(overrides);
  });

  it("linhas normalizadas idênticas (decimais pt-PT, BOM, campos com ; escapado)", () => {
    const rows = parseSupplierFile(CSV_PT).rows;
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      supplierSku: "REF-001",
      name: "Cabo HDMI; 2m",
      costPrice: "10.00",
      stock: 8,
      ean: "5901234123457",
      internalSku: null,
    });
    expect(rows[1]).toMatchObject({ supplierSku: "REF-002", costPrice: "1234.56", stock: 0 });
    expect(parseSupplierFile(CSV_PT).rows).toEqual(parseSupplierCsv(CSV_PT).rows);
  });

  it("propaga os MESMOS erros de ficheiro do parser original", () => {
    const cases: [string, string][] = [
      ["   ", "CSV_EMPTY"],
      ["coluna,sem,chave\n1,2,3", "CSV_MISSING_KEY_COLUMN"],
      ["custo;precodecusto\n1;2", "DUPLICATE_MAPPING:costPrice"],
      ["skuFornecedor\n", "CSV_NO_DATA"],
    ];
    for (const [text, code] of cases) {
      let dispatcherErr: unknown;
      let parserErr: unknown;
      try {
        parseSupplierFile(text);
      } catch (e) {
        dispatcherErr = e;
      }
      try {
        parseSupplierCsv(text);
      } catch (e) {
        parserErr = e;
      }
      expect(dispatcherErr).toBeInstanceOf(SupplierCsvError);
      expect((dispatcherErr as SupplierCsvError).code).toBe(code);
      expect((dispatcherErr as SupplierCsvError).code).toBe((parserErr as SupplierCsvError).code);
    }
  });

  it("nesta etapa existe APENAS o ramo csv", () => {
    expect([...SUPPLIER_FILE_FORMATS]).toEqual(["csv"]);
  });
});

describe("C.3.3 — resolveSupplierFileMapping (semântica C.3.2)", () => {
  const PROFILE = {
    id: 7,
    mapping: { skuFornecedor: "supplierSku", nome: "name", custo: "costPrice", stock: "stock", ean: "ean" },
  };
  const BAD_PROFILE = { id: 8, mapping: { colunaQueNaoExiste: "supplierSku" } };

  it("sem perfil → parse inicial, sem re-parse, no_profile", () => {
    const initial = parseSupplierCsv(CSV_PT);
    const reparse = vi.fn(() => parseSupplierCsv(CSV_PT));
    const { parsed, resolution } = resolveSupplierFileMapping({
      initial, reparse, manualMapping: undefined, profile: null,
    });
    expect(parsed).toBe(initial);
    expect(reparse).not.toHaveBeenCalled();
    expect(resolution).toEqual({ type: "no_profile", mapping: initial.mapping });
  });

  it("perfil compatível sem mapping manual → re-parse com o mapping do perfil", () => {
    const initial = parseSupplierCsv(CSV_PT);
    const reparsed = parseSupplierCsv(CSV_PT, PROFILE.mapping);
    const reparse = vi.fn(() => reparsed);
    const { parsed, resolution } = resolveSupplierFileMapping({
      initial, reparse, manualMapping: undefined, profile: PROFILE,
    });
    expect(reparse).toHaveBeenCalledTimes(1);
    expect(reparse).toHaveBeenCalledWith(PROFILE.mapping);
    expect(parsed).toBe(reparsed);
    expect(resolution).toEqual({ type: "profile_valid", mapping: PROFILE.mapping, profileId: PROFILE.id });
  });

  it("perfil incompatível → fallback seguro: MESMO objeto do parse inicial, sem re-parse", () => {
    const initial = parseSupplierCsv(CSV_PT);
    const reparse = vi.fn(() => parseSupplierCsv(CSV_PT));
    const { parsed, resolution } = resolveSupplierFileMapping({
      initial, reparse, manualMapping: undefined, profile: BAD_PROFILE,
    });
    expect(parsed).toBe(initial);
    expect(reparse).not.toHaveBeenCalled();
    expect(resolution).toEqual({
      type: "profile_invalid",
      reason: "O formato desta lista parece ter mudado. Confirme o mapeamento antes de continuar.",
      mapping: BAD_PROFILE.mapping,
      profileId: BAD_PROFILE.id,
    });
  });

  it("mapping manual não vazio tem prioridade — perfil válido é reportado mas NÃO aplicado", () => {
    const manual = { skuFornecedor: "supplierSku", nome: "name" };
    const initial = parseSupplierCsv(CSV_PT, manual);
    const reparse = vi.fn(() => parseSupplierCsv(CSV_PT));
    const { parsed, resolution } = resolveSupplierFileMapping({
      initial, reparse, manualMapping: manual, profile: PROFILE,
    });
    expect(parsed).toBe(initial);
    expect(reparse).not.toHaveBeenCalled();
    expect(resolution).toEqual({ type: "profile_valid", mapping: PROFILE.mapping, profileId: PROFILE.id });
  });

  it("mapping manual não vazio + perfil incompatível → manual mantém-se, fallback reportado", () => {
    const manual = { skuFornecedor: "supplierSku", nome: "name" };
    const initial = parseSupplierCsv(CSV_PT, manual);
    const { parsed, resolution } = resolveSupplierFileMapping({
      initial, reparse: () => parseSupplierCsv(CSV_PT), manualMapping: manual, profile: BAD_PROFILE,
    });
    expect(parsed).toBe(initial);
    expect(resolution.type).toBe("profile_invalid");
  });
});

describe("C.3.3 — isProfileCompatibleWithHeaders (movida, semântica intacta)", () => {
  it("trim+lowercase no header (espaços internos contam); header ausente → falso", () => {
    expect(isProfileCompatibleWithHeaders({ " SKU Fornecedor ": "supplierSku" }, ["sku fornecedor"])).toBe(true);
    expect(isProfileCompatibleWithHeaders({ skuFornecedor: "supplierSku", preco: "costPrice" }, ["skufornecedor"])).toBe(false);
  });
});
