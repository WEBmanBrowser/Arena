import { describe, expect, it } from "vitest";
import {
  expandWintouchFiscalLines,
  selectPaidWintouchDocumentKind,
} from "./wintouch-invoicing-service";

describe("WINTOUCH final checkout values", () => {
  it("preserves an allocated discount to the cent without losing quantity", () => {
    const lines = expandWintouchFiscalLines([{
      description: "Artigo",
      sku: "SKU",
      quantity: 3,
      lineTotalCents: 1000,
      vatRate: "23.00",
    }]);

    expect(lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(3);
    expect(lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0)).toBe(1000);
    expect(lines).toEqual([
      expect.objectContaining({ quantity: 2, unitPriceCents: 333 }),
      expect.objectContaining({ quantity: 1, unitPriceCents: 334 }),
    ]);
  });

  it("keeps a shipping row as an exact gross amount", () => {
    const lines = expandWintouchFiscalLines([{
      description: "Portes de envio",
      sku: "SHIPPING",
      quantity: 1,
      lineTotalCents: 790,
      vatRate: "23.00",
    }]);

    expect(lines).toEqual([expect.objectContaining({
      quantity: 1,
      unitPriceCents: 790,
      vatRate: "23.00",
    })]);
  });

  it("uses FS through 1000 euros and FATREC above it", () => {
    expect(selectPaidWintouchDocumentKind(100000)).toBe("simplified_invoice");
    expect(selectPaidWintouchDocumentKind(100001)).toBe("invoice_receipt");
  });
});
