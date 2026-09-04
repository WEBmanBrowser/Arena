/**
 * Import-error text regression.
 *
 * Both importers used to coerce errors directly into the DOM — an array of
 * objects `.join(", ")` or an object dropped into a template — which rendered
 * "[object Object]" instead of the code/field/message the API actually sent.
 * These tests lock the shared formatters that replaced that coercion, plus the
 * shared API/UI message resolver used by the supplier panel.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  formatImportError,
  formatImportErrors,
  formatImportValue,
} from "@/lib/import-error-text";
import {
  classifyImportStorageFailure,
  supplierImportErrorMessage,
} from "@/lib/supplier-import/error-messages";

describe("formatImportError — structured error payloads", () => {
  it("keeps code, field, message and line when present", () => {
    const text = formatImportError({ row: 5, field: "ean", code: "EAN_TOO_LONG", message: "EAN demasiado longo" });
    expect(text).toContain("linha 5");
    expect(text).toContain("campo ean");
    expect(text).toContain("EAN_TOO_LONG");
    expect(text).toContain("EAN demasiado longo");
  });

  it("accepts `line` as an alias of `row`", () => {
    const text = formatImportError({ line: 12, code: "INVALID_GTIN", message: "checksum" });
    expect(text).toContain("linha 12");
  });

  it("renders a bare message when nothing else is present", () => {
    expect(formatImportError({ message: "só a mensagem" })).toBe("só a mensagem");
  });

  it("never repeats a message that equals its code", () => {
    const text = formatImportError({ code: "CSV_EMPTY", message: "CSV_EMPTY" });
    expect(text).toBe("CSV_EMPTY");
  });
});

describe("formatImportError — Error, scalars and unknown objects", () => {
  it("shows an Error's message without its stack", () => {
    const err = new Error("Falha na base de dados");
    (err as Error & { stack?: string }).stack = "    at file:1:1\n    at other:2:2";
    const text = formatImportError(err);
    expect(text).toContain("Falha na base de dados");
    expect(text).not.toContain("at file");
    expect(text).not.toContain("stack");
  });

  it("passes strings and numbers through", () => {
    expect(formatImportError("SKU vazio")).toBe("SKU vazio");
    expect(formatImportError(42)).toBe("42");
    expect(formatImportError(0)).toBe("0");
  });

  it("never turns an unknown object into [object Object]", () => {
    const text = formatImportError({ something: 1, nested: { a: 2 } });
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("something");
  });

  it("renders a safe label when an object has nothing renderable", () => {
    expect(formatImportError({})).toBe("Erro desconhecido");
    expect(formatImportError(() => 1)).toBe("Erro desconhecido");
  });

  it("ignores stack/query/params wherever the server put them", () => {
    const text = formatImportError({
      code: "DB_ERROR",
      message: "erro controlado",
      stack: "at handler (route.ts:12)",
      query: "SELECT * FROM products",
      params: ["abc", 1],
    });
    expect(text).toContain("DB_ERROR");
    expect(text).toContain("erro controlado");
    expect(text).not.toContain("SELECT");
    expect(text).not.toContain("route.ts");
    expect(text).not.toMatch(/params/);

    const unknown = formatImportError({ query: "DELETE FROM products", stack: "at x", params: [1] });
    expect(unknown).not.toContain("DELETE");
    expect(unknown).not.toContain("at x");
    expect(unknown).not.toContain("[object Object]");
  });

  it("caps excessively long text", () => {
    const long = formatImportError("x".repeat(5000));
    expect(long.length).toBeLessThan(500);
  });
});

describe("formatImportErrors — lists collapse and dedupe", () => {
  it("formats every item and collapses repeated messages", () => {
    const text = formatImportErrors([
      { row: 2, field: "ean", code: "EAN_TOO_LONG", message: "EAN demasiado longo" },
      { row: 3, field: "ean", code: "INVALID_GTIN", message: "checksum inválido" },
      { row: 4, field: "ean", code: "EAN_TOO_LONG", message: "EAN demasiado longo" },
    ]);
    expect(text).toContain("EAN_TOO_LONG");
    expect(text).toContain("INVALID_GTIN");
    expect(text).toContain("linhas 2, 4"); // same code+message merged, lines kept
    expect(text.match(/EAN demasiado longo/g)).toHaveLength(1);
  });

  it("accepts a single error, a scalar list and an {errors} wrapper", () => {
    expect(formatImportErrors({ code: "X", message: "um" })).toBe("X · um");
    expect(formatImportErrors({ message: "só mensagem" })).toBe("só mensagem");
    expect(formatImportErrors(["a", "b"])).toBe("a; b");
    expect(formatImportErrors({ errors: [{ message: "m1" }, { message: "m2" }] })).toBe("m1; m2");
    expect(formatImportErrors(null)).toBe("");
    expect(formatImportErrors(undefined)).toBe("");
  });
});

describe("formatImportValue — change cells", () => {
  it("renders {from, to} pairs as from → to", () => {
    expect(formatImportValue({ from: "100.00", to: "14.99" })).toBe("100.00 → 14.99");
  });

  it("renders scalars without object coercion", () => {
    expect(formatImportValue("cabo")).toBe("cabo");
    expect(formatImportValue(8)).toBe("8");
    expect(formatImportValue(null)).toBe("—");
    expect(formatImportValue(undefined)).toBe("—");
    expect(formatImportValue({ something: true })).not.toContain("[object Object]");
  });
});

describe("supplierImportErrorMessage — shared API/UI messages", () => {
  it("gives an explicit safe server message priority over the table", () => {
    expect(supplierImportErrorMessage("CSV_EMPTY", "Ficheiro vazio.", undefined)).toBe("Ficheiro vazio.");
    expect(supplierImportErrorMessage("CSV_EMPTY", "  ", undefined)).toBe("CSV vazio.");
  });

  it("resolves known codes from the shared table", () => {
    expect(supplierImportErrorMessage("CSV_EMPTY")).toBe("CSV vazio.");
    expect(supplierImportErrorMessage("SUPPLIER_IMPORT_APPLY_FAILED")).toContain("pode retomar");
    expect(supplierImportErrorMessage("CSV_TOO_MANY_ROWS")).toContain("10000");
  });

  it("falls back to the code itself for unknown codes and a generic sentence without any code", () => {
    expect(supplierImportErrorMessage("ALGO_DESCONHECIDO")).toBe("ALGO_DESCONHECIDO");
    expect(supplierImportErrorMessage(undefined, undefined)).toBe("Ocorreu um erro.");
  });

  it("resolves DUPLICATE_MAPPING codes with the field name", () => {
    expect(supplierImportErrorMessage("DUPLICATE_MAPPING:costPrice")).toBe("Duas colunas mapeadas para o custo.");
    expect(supplierImportErrorMessage("DUPLICATE_MAPPING:supplierSku")).toBe("Duas colunas mapeadas para o SKU do fornecedor.");
  });

  it("classifies storage failures into safe categories without leaking details", () => {
    const long = classifyImportStorageFailure({ code: "22001", message: 'value too long for type character varying(50)' });
    expect(long?.code).toBe("IMPORT_VALUE_TOO_LONG");
    expect(long?.message).not.toContain("character varying");
    const range = classifyImportStorageFailure({ code: "22003", message: "numeric field overflow" });
    expect(range?.code).toBe("IMPORT_VALUE_OUT_OF_RANGE");
    expect(range?.message).not.toContain("overflow");
    const schema = classifyImportStorageFailure({ code: "42P01", message: 'relation "supplier_import_rows" does not exist' });
    expect(schema?.code).toBe("IMPORT_SCHEMA_MISSING");
    expect(schema?.message).toContain("0010");
    expect(schema?.message).not.toContain("supplier_import_rows");
    expect(classifyImportStorageFailure(new Error("qualquer coisa"))).toBeNull();
    expect(classifyImportStorageFailure(null)).toBeNull();
  });
});

describe("both admin import panels stop coercing arrays/objects directly", () => {
  const root = path.resolve(__dirname, "..", "..");
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

  it("legacy page: uses the formatters, the real row key and no errors.join", () => {
    const page = read("src/app/admin/import/page.tsx");
    expect(page).toContain("formatImportErrors(r.errors)");
    expect(page).toContain("formatImportValue(v)");
    expect(page).not.toMatch(/errors\??\.join\s*\(/);
    // The API returns `row`, the table must not render `r.line`.
    expect(page).toContain("r.row");
    expect(page).not.toContain("r.line");
    // A failed execute must never show the success banner.
    expect(page).toMatch(/result\?\.summary && !result\.error/);
  });

  it("legacy page: tolerant body reading and try/finally around loading", () => {
    const page = read("src/app/admin/import/page.tsx");
    expect(page).toContain("async function readBody");
    expect(page).toMatch(/\bfinally\b/);
    expect(page).not.toContain("details: e.message");
  });

  it("supplier panel: shows issues as text with code/field/message, server message first", () => {
    const panel = read("src/components/admin/SupplierImportPanel.tsx");
    expect(panel).toContain("formatImportErrors(");
    expect(panel).toContain("code: i.code, field: i.field, message: i.message");
    expect(panel).toContain('supplierImportErrorMessage(body?.error, body?.message)');
    // No local duplicated message table anymore (it lives in error-messages.ts).
    expect(panel).not.toContain("const MESSAGES: Record<string, string>");
    expect(panel).not.toContain("r.errors?.join");
    expect(panel).toContain("async function readBody");
  });
});
