import { describe, expect, it } from "vitest";
import { buildWintouchInvoicePayload } from "./adapter";

const ENV = {
  WINTOUCH_FT_DOCUMENT_TYPE_ID:
    "11111111-1111-4111-8111-111111111111",

  WINTOUCH_FT_DOCUMENT_SERIE_ID:
    "22222222-2222-4222-8222-222222222222",

  WINTOUCH_FS_DOCUMENT_TYPE_ID:
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",

  WINTOUCH_FS_DOCUMENT_SERIE_ID:
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",

  WINTOUCH_FR_DOCUMENT_TYPE_ID:
    "12121212-1212-4121-8121-121212121212",

  WINTOUCH_FR_DOCUMENT_SERIE_ID:
    "34343434-3434-4343-8343-343434343434",

  WINTOUCH_SECTOR_ID:
    "33333333-3333-4333-8333-333333333333",

  WINTOUCH_WORKSTATION_ID:
    "44444444-4444-4444-8444-444444444444",

  WINTOUCH_PAYMENT_METHOD_BANK_TRANSFER_ID:
    "55555555-5555-4555-8555-555555555555",

  WINTOUCH_ENTERPRISE_ID:
    "99999999-9999-4999-8999-999999999999",

  WINTOUCH_CURRENCY_ID:
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",

  WINTOUCH_COUNTRY_ID:
    "abababab-abab-4bab-8bab-abababababab",

  WINTOUCH_VAT_ID:
    "66666666-6666-4666-8666-666666666666",

  WINTOUCH_VAT_RATE: "23",
  WINTOUCH_SAVE_MODE: "0",

  WINTOUCH_PRODUCT_ID:
    "77777777-7777-4777-8777-777777777777",

  WINTOUCH_WAREHOUSE_ID:
    "88888888-8888-4888-8888-888888888888",
};

function withEnv<T>(fn: () => T): T {
  const old = { ...process.env };

  Object.assign(process.env, ENV);

  try {
    return fn();
  } finally {
    process.env = old;
  }
}

function withMissingEnv<T>(
  names: string[],
  fn: () => T,
): T {
  return withEnv(() => {
    for (const name of names) {
      delete process.env[name];
    }

    return fn();
  });
}

const LINE = {
  description: "Artigo",
  sku: "SKU-TESTE",
  quantity: 1,
  unitPriceCents: 123,
  vatRate: "23.00",
};

describe(
  "WINTOUCH adapter FT/FS fiscal safety",
  () => {
    it(
      "uses S26 FT profile and empty Payments for FT",
      () =>
        withEnv(() => {
          const p =
            buildWintouchInvoicePayload({
              orderId: 1,
              documentType: "invoice",
              fiscalDocumentKind: "invoice",

              customerName:
                "Cliente Identificado",

              customerNif:
                "123456789",

              customerProviderEntityId:
                "dddddddd-dddd-4ddd-8ddd-dddddddddddd",

              expectedTotalCents: 123,
              lines: [LINE],
            }) as {
              DocumentTypeID: string;
              DocumentSerieID: string;
              EntityID?: string;
              Payments: unknown[];
            };

          expect(
            p.DocumentTypeID,
          ).toBe(
            ENV.WINTOUCH_FT_DOCUMENT_TYPE_ID,
          );

          expect(
            p.DocumentSerieID,
          ).toBe(
            ENV.WINTOUCH_FT_DOCUMENT_SERIE_ID,
          );

          expect(p.EntityID).toBe(
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          );

          expect(p.Payments).toEqual([]);
        }),
    );

    it(
      "uses S26 FS profile and payment for anonymous FS",
      () =>
        withEnv(() => {
          const p =
            buildWintouchInvoicePayload({
              orderId: 2,
              documentType: "invoice",

              fiscalDocumentKind:
                "simplified_invoice",

              paymentMethod: "bank_transfer",

              customerName:
                "Consumidor final",

              customerNif: null,

              customerProviderEntityId:
                null,

              expectedTotalCents: 123,
              lines: [LINE],
            }) as {
              DocumentTypeID: string;
              DocumentSerieID: string;
              EntityID?: string;
              VATNumber?: string;
              Payments: Array<{
                PaymentMethodID: string;
                Amount: number;
              }>;
            };

          expect(
            p.DocumentTypeID,
          ).toBe(
            ENV.WINTOUCH_FS_DOCUMENT_TYPE_ID,
          );

          expect(
            p.DocumentSerieID,
          ).toBe(
            ENV.WINTOUCH_FS_DOCUMENT_SERIE_ID,
          );

          expect(
            "EntityID" in p,
          ).toBe(false);

          expect(
            "VATNumber" in p,
          ).toBe(false);

          expect(
            p.Payments,
          ).toHaveLength(1);

          expect(
            p.Payments[0].PaymentMethodID,
          ).toBe(
            ENV.WINTOUCH_PAYMENT_METHOD_BANK_TRANSFER_ID,
          );

          expect(
            p.Payments[0].Amount,
          ).toBe(1.23);
        }),
    );

    it(
      "does not allow a supplied NIF on FS without resolved EntityID",
      () =>
        withEnv(() => {
          expect(() =>
            buildWintouchInvoicePayload({
              orderId: 3,
              documentType: "invoice",

              fiscalDocumentKind:
                "simplified_invoice",

              paymentMethod: "bank_transfer",

              customerName: "Cliente",

              customerNif:
                "123456789",

              customerProviderEntityId:
                null,

              expectedTotalCents: 123,
              lines: [LINE],
            }),
          ).toThrow();
        }),
    );

    it(
      "uses FATREC profile and payment above the FS limit",
      () =>
        withEnv(() => {
          const p = buildWintouchInvoicePayload({
            orderId: 21,
            documentType: "invoice",
            fiscalDocumentKind: "invoice_receipt",
            paymentMethod: "bank_transfer",
            customerName: "Consumidor final",
            customerNif: null,
            customerProviderEntityId: null,
            expectedTotalCents: 100001,
            lines: [{ ...LINE, unitPriceCents: 100001 }],
          }) as {
            DocumentTypeID: string;
            DocumentSerieID: string;
            EntityID?: string;
            VATNumber?: string;
            DueDate?: string;
            Payments: Array<{ PaymentMethodID: string; Amount: number }>;
          };

          expect(p.DocumentTypeID).toBe(ENV.WINTOUCH_FR_DOCUMENT_TYPE_ID);
          expect(p.DocumentSerieID).toBe(ENV.WINTOUCH_FR_DOCUMENT_SERIE_ID);
          expect("EntityID" in p).toBe(false);
          expect("VATNumber" in p).toBe(false);
          expect("DueDate" in p).toBe(false);
          expect(p.Payments).toEqual([expect.objectContaining({
            PaymentMethodID: ENV.WINTOUCH_PAYMENT_METHOD_BANK_TRANSFER_ID,
            Amount: 1000.01,
          })]);
        }),
    );

    it("does not require an FT profile for paid FS/FATREC flows", () => {
      const old = { ...process.env };
      Object.assign(process.env, ENV);
      delete process.env.WINTOUCH_FT_DOCUMENT_TYPE_ID;
      delete process.env.WINTOUCH_FT_DOCUMENT_SERIE_ID;

      try {
        const fs = buildWintouchInvoicePayload({
          orderId: 23,
          documentType: "invoice",
          fiscalDocumentKind: "simplified_invoice",
          paymentMethod: "bank_transfer",
          customerName: "Consumidor final",
          expectedTotalCents: 123,
          lines: [LINE],
        }) as { DocumentTypeID: string };

        const fr = buildWintouchInvoicePayload({
          orderId: 24,
          documentType: "invoice",
          fiscalDocumentKind: "invoice_receipt",
          paymentMethod: "bank_transfer",
          customerName: "Consumidor final",
          expectedTotalCents: 123,
          lines: [LINE],
        }) as { DocumentTypeID: string };

        expect(fs.DocumentTypeID).toBe(ENV.WINTOUCH_FS_DOCUMENT_TYPE_ID);
        expect(fr.DocumentTypeID).toBe(ENV.WINTOUCH_FR_DOCUMENT_TYPE_ID);
      } finally {
        process.env = old;
      }
    });

    it("still fails closed if an explicit FT is requested without its profile", () => {
      const old = { ...process.env };
      Object.assign(process.env, ENV);
      delete process.env.WINTOUCH_FT_DOCUMENT_TYPE_ID;
      delete process.env.WINTOUCH_FT_DOCUMENT_SERIE_ID;

      try {
        expect(() => buildWintouchInvoicePayload({
          orderId: 25,
          documentType: "invoice",
          fiscalDocumentKind: "invoice",
          customerName: "Cliente",
          customerNif: "123456789",
          customerProviderEntityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          expectedTotalCents: 123,
          lines: [LINE],
        })).toThrow();
      } finally {
        process.env = old;
      }
    });

    it(
      "requires a resolved entity when FATREC carries a NIF",
      () => withEnv(() => {
        expect(() => buildWintouchInvoicePayload({
          orderId: 22,
          documentType: "invoice",
          fiscalDocumentKind: "invoice_receipt",
          paymentMethod: "bank_transfer",
          customerName: "Cliente identificado",
          customerNif: "123456789",
          customerProviderEntityId: null,
          expectedTotalCents: 123,
          lines: [LINE],
        })).toThrow();
      }),
    );

    it(
      "does not allow FT without resolved EntityID",
      () =>
        withEnv(() => {
          expect(() =>
            buildWintouchInvoicePayload({
              orderId: 4,
              documentType: "invoice",

              fiscalDocumentKind:
                "invoice",

              customerName: "Cliente",

              expectedTotalCents: 123,
              lines: [LINE],
            }),
          ).toThrow();
        }),
    );

    it(
      "uses gross store price as RowUnitPrice",
      () =>
        withEnv(() => {
          const p =
            buildWintouchInvoicePayload({
              orderId: 5,
              documentType: "invoice",

              fiscalDocumentKind:
                "simplified_invoice",

              paymentMethod: "bank_transfer",

              customerName:
                "Consumidor final",

              expectedTotalCents: 123,
              lines: [LINE],
            }) as {
              ProductDocumentDetails:
                Array<Record<string, unknown>>;
            };

          const line =
            p.ProductDocumentDetails[0];

          expect(
            line.ProductID,
          ).toBe(
            ENV.WINTOUCH_PRODUCT_ID,
          );

          expect(
            line.WharehouseID,
          ).toBe(
            ENV.WINTOUCH_WAREHOUSE_ID,
          );

          expect(
            line.AddedWithVATIncluded,
          ).toBe(true);

          expect(
            line.RowUnitPrice,
          ).toBe(1.23);

          expect(
            line.UnitPriceWithVAT,
          ).toBe(1.23);

          expect(
            "UnitPriceWithoutVAT" in line,
          ).toBe(false);

          expect(
            line.StockUnitFactor,
          ).toBe(1);

          expect(
            line.VATTax,
          ).toBe(23);
        }),
    );

    it("uses the workstation field defined by the WINTOUCH API", () =>
      withEnv(() => {
        const payload = buildWintouchInvoicePayload({
          orderId: 5,
          documentType: "invoice",
          fiscalDocumentKind: "simplified_invoice",
          paymentMethod: "bank_transfer",
          customerName: "Consumidor final",
          expectedTotalCents: 123,
          lines: [LINE],
        }) as Record<string, unknown>;

        expect(payload.CreatedWorkstationID).toBe(ENV.WINTOUCH_WORKSTATION_ID);
        expect("CreatedWorkStationID" in payload).toBe(false);
      }),
    );

    it(
      "fails closed when fiscal lines do not equal order total",
      () =>
        withEnv(() => {
          expect(() =>
            buildWintouchInvoicePayload({
              orderId: 6,
              documentType: "invoice",

              fiscalDocumentKind:
                "simplified_invoice",

              paymentMethod: "bank_transfer",

              customerName:
                "Consumidor final",

              expectedTotalCents: 124,
              lines: [LINE],
            }),
          ).toThrow();
        }),
    );
  },
);

describe(
  "WINTOUCH checkout payment mapping",
  () => {
    it(
      "fails closed for FS Multibanco when no WINTOUCH mapping exists",
      () =>
        withMissingEnv(["WINTOUCH_PAYMENT_METHOD_MULTIBANCO_ID"], () => {
          expect(() =>
            buildWintouchInvoicePayload({
              orderId: 7001,
              documentType: "invoice",
              fiscalDocumentKind:
                "simplified_invoice",
              paymentMethod: "multibanco",
              customerName:
                "Consumidor final",
              customerNif: null,
              expectedTotalCents: 123,
              lines: [LINE],
            }),
          ).toThrow();
        }),
    );

    it(
      "fails closed for FS MB WAY when no WINTOUCH mapping exists",
      () =>
        withMissingEnv(["WINTOUCH_PAYMENT_METHOD_MBWAY_ID"], () => {
          expect(() =>
            buildWintouchInvoicePayload({
              orderId: 7002,
              documentType: "invoice",
              fiscalDocumentKind:
                "simplified_invoice",
              paymentMethod: "mbway",
              customerName:
                "Consumidor final",
              customerNif: null,
              expectedTotalCents: 123,
              lines: [LINE],
            }),
          ).toThrow();
        }),
    );

    it.each([
      ["multibanco", "WINTOUCH_PAYMENT_METHOD_MULTIBANCO_ID", "10101010-1010-4010-8010-101010101010"],
      ["mbway", "WINTOUCH_PAYMENT_METHOD_MBWAY_ID", "20202020-2020-4020-8020-202020202020"],
      ["card", "WINTOUCH_PAYMENT_METHOD_CARD_ID", "30303030-3030-4030-8030-303030303030"],
    ] as const)(
      "maps paid checkout method %s to its configured WINTOUCH PaymentMethodID",
      (paymentMethod, envName, expectedId) =>
        withEnv(() => {
          process.env[envName] = expectedId;
          const p = buildWintouchInvoicePayload({ orderId: 7010, documentType: "invoice", fiscalDocumentKind: "simplified_invoice", paymentMethod, customerName: "Consumidor final", customerNif: null, expectedTotalCents: 123, lines: [LINE] }) as { Payments: Array<{ PaymentMethodID: string }> };
          expect(p.Payments).toHaveLength(1);
          expect(p.Payments[0]?.PaymentMethodID).toBe(expectedId);
        }),
    );

    it(
      "does not require payment mapping for FT",
      () =>
        withEnv(() => {
          const p =
            buildWintouchInvoicePayload({
              orderId: 7003,
              documentType: "invoice",
              fiscalDocumentKind: "invoice",
              paymentMethod: "mbway",
              customerName:
                "Cliente identificado",
              customerNif:
                "123456789",
              customerProviderEntityId:
                "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              expectedTotalCents: 123,
              lines: [LINE],
            }) as {
              Payments: unknown[];
            };

          expect(p.Payments).toEqual([]);
        }),
    );
  },
);


describe("WINTOUCH DueDate by fiscal document kind", () => {
  it("omits DueDate from simplified invoice", () =>
    withEnv(() => {
      const payload =
        buildWintouchInvoicePayload({
          orderId: 8001,
          documentType: "invoice",
          fiscalDocumentKind: "simplified_invoice",
          paymentMethod: "bank_transfer",
          customerName: "Consumidor final",
          customerNif: null,
          customerProviderEntityId: null,
          expectedTotalCents: 123,
          lines: [LINE],
        }) as Record<string, unknown>;

      expect("DueDate" in payload).toBe(false);
    }));

  it("keeps DueDate on FT", () =>
    withEnv(() => {
      const payload =
        buildWintouchInvoicePayload({
          orderId: 8002,
          documentType: "invoice",
          fiscalDocumentKind: "invoice",
          paymentMethod: "bank_transfer",
          customerName: "Cliente identificado",
          customerNif: "123456789",
          customerProviderEntityId:
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          expectedTotalCents: 123,
          lines: [LINE],
        }) as Record<string, unknown>;

      expect(typeof payload.DueDate).toBe("string");
    }));
});
