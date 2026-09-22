import { ProviderError } from "../errors";
import type { CreateInvoiceRequest, InvoiceProviderAdapter, InvoiceProviderResult } from "../invoice-provider";
import { wintouchAmbiguousError, wintouchRequest } from "./client";
import { resolveWintouchConfig, resolveWintouchFiscalConfig, WINTOUCH_PROVIDER_ID } from "./config";

type JsonObject = Record<string, unknown>;
function objectOf(value: unknown): JsonObject | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null; }
function textField(o: JsonObject | null, ...keys: string[]): string | null { for (const k of keys) { const v=o?.[k]; if (typeof v === "string" && v.trim()) return v.trim(); if (typeof v === "number" && Number.isFinite(v)) return String(v); } return null; }
function providerFailure(status: number): ProviderError { return new ProviderError(status === 401 || status === 403 ? "PROVIDER_UNAVAILABLE" : "INVALID_PROVIDER_RESPONSE", { provider: WINTOUCH_PROVIDER_ID, internalDetail: `WINTOUCH HTTP ${status}` }); }
function resultFrom(body: unknown, series: string | null = null): InvoiceProviderResult {
  const o=objectOf(body); const id=textField(o,"ID","Id","id");
  if (!id) throw new ProviderError("INVALID_PROVIDER_RESPONSE", { provider: WINTOUCH_PROVIDER_ID, internalDetail: "document response without ID" });
  return { providerDocumentId:id, documentNumber:textField(o,"DocumentNumber","documentNumber"), series, status:"issued", issuedAt:new Date(), documentReference:id };
}
function resolveWintouchPaymentMethodId(
  checkoutMethod: string | null | undefined,
  fiscal: ReturnType<typeof resolveWintouchFiscalConfig>,
): string {
  const method =
    checkoutMethod?.trim().toLowerCase();

  let id: string | null = null;

  switch (method) {
    case "bank_transfer":
      id = fiscal.paymentMethods.bankTransfer;
      break;

    case "multibanco":
      id = fiscal.paymentMethods.multibanco;
      break;

    case "mbway":
      id = fiscal.paymentMethods.mbway;
      break;

    case "card":
      id = fiscal.paymentMethods.card;
      break;

    default:
      throw new ProviderError(
        "OPERATION_NOT_SUPPORTED",
        {
          provider: WINTOUCH_PROVIDER_ID,
          internalDetail:
            `unsupported checkout payment method: ${String(checkoutMethod)}`,
        },
      );
  }

  if (!id) {
    throw new ProviderError(
      "OPERATION_NOT_SUPPORTED",
      {
        provider: WINTOUCH_PROVIDER_ID,
        internalDetail:
          `WINTOUCH payment method not configured for ${method}`,
      },
    );
  }

  return id;
}

export function buildWintouchInvoicePayload(
  request: CreateInvoiceRequest,
) {
  if (request.documentType !== "invoice") {
    throw new ProviderError(
      "OPERATION_NOT_SUPPORTED",
      {
        provider: WINTOUCH_PROVIDER_ID,
        internalDetail:
          "credit note requires source-document mapping",
      },
    );
  }

  if (!request.lines.length) {
    throw new ProviderError(
      "INVALID_PROVIDER_RESPONSE",
      {
        provider: WINTOUCH_PROVIDER_ID,
        internalDetail: "invoice without lines",
      },
    );
  }

  const linesTotal = request.lines.reduce(
    (n, l) =>
      n + l.unitPriceCents * l.quantity,
    0,
  );

  if (
    request.expectedTotalCents !== undefined &&
    linesTotal !== request.expectedTotalCents
  ) {
    throw new ProviderError(
      "OPERATION_NOT_SUPPORTED",
      {
        provider: WINTOUCH_PROVIDER_ID,
        internalDetail:
          "order total does not reconcile with fiscal lines",
      },
    );
  }

  const fiscal = resolveWintouchFiscalConfig();

  const kind =
    request.fiscalDocumentKind ?? "invoice";

  const isSimplified =
    kind === "simplified_invoice";

  const isInvoiceReceipt =
    kind === "invoice_receipt";

  const isPaidDocument =
    isSimplified || isInvoiceReceipt;

  const profile = isSimplified
    ? fiscal.simplifiedInvoice
    : isInvoiceReceipt
      ? fiscal.invoiceReceipt
      : fiscal.invoice;

  if (!profile) {
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      {
        provider: WINTOUCH_PROVIDER_ID,
        internalDetail: "WINTOUCH FT profile is not configured",
      },
    );
  }

  /*
   * FT identified customer:
   * EntityID is mandatory in our integration.
   *
   * FS/FATREC without customer NIF:
   * anonymous/consumer-final flow is allowed without
   * inventing an EntityID or storing a fake NIF.
   *
   * FS/FATREC WITH a customer NIF still requires the resolved
   * WINTOUCH entity, so a supplied NIF can never silently
   * become an anonymous document.
   */
  const entityId =
    request.customerProviderEntityId?.trim() ||
    null;

  const hasCustomerNif =
    Boolean(request.customerNif?.trim());

  const entityRequired =
    kind === "invoice" || hasCustomerNif;

  if (
    entityRequired &&
    (
      !entityId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        entityId,
      )
    )
  ) {
    throw new ProviderError(
      "OPERATION_NOT_SUPPORTED",
      {
        provider: WINTOUCH_PROVIDER_ID,
        internalDetail:
          "WINTOUCH customer EntityID is required before identified fiscal creation",
      },
    );
  }

  if (
    entityId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      entityId,
    )
  ) {
    throw new ProviderError(
      "OPERATION_NOT_SUPPORTED",
      {
        provider: WINTOUCH_PROVIDER_ID,
        internalDetail:
          "invalid WINTOUCH customer EntityID",
      },
    );
  }

  for (const line of request.lines) {
    const vatRate = Number(line.vatRate);

    if (
      !Number.isFinite(vatRate) ||
      Math.abs(vatRate - fiscal.vatRate) >
        0.000001
    ) {
      throw new ProviderError(
        "OPERATION_NOT_SUPPORTED",
        {
          provider: WINTOUCH_PROVIDER_ID,
          internalDetail:
            `unsupported VAT rate ${String(line.vatRate)}; configured WINTOUCH rate is ${fiscal.vatRate}`,
        },
      );
    }
  }

  const documentDate =
    new Date().toISOString();

  /*
   * FT carries no Payments in the current WINTOUCH model.
   * FS and FATREC are paid documents and require payment mapping.
   */
  const paymentMethodId =
    isPaidDocument
      ? resolveWintouchPaymentMethodId(
          request.paymentMethod,
          fiscal,
        )
      : null;

  const payload: Record<string, unknown> = {
    Date: documentDate,
    /* FS/FATREC pagos no momento: omitir DueDate. */
    ...(!isPaidDocument
      ? { DueDate: documentDate }
      : { }),

    CurrencyID: fiscal.currencyId,

    DocumentSerieID:
      profile.documentSerieId,

    DocumentTypeID:
      profile.documentTypeId,

    SectorID: fiscal.sectorId,

    CreatedWorkstationID:
      fiscal.workstationId,

    SaveMode: fiscal.saveMode,

    ExternalDocument:
      request.externalReference ??
      `ORDER-${request.orderId}`,

    /*
     * Do not manufacture customer identity.
     * Anonymous FS simply omits EntityID/VATNumber.
     */
    ...(entityId
      ? { EntityID: entityId }
      : {}),

    ...(request.customerName
      ? { EntityName: request.customerName }
      : {}),

    ...(request.customerNif
      ? { VATNumber: request.customerNif }
      : {}),

    ...(request.billingAddress?.address1
      ? {
          Address1:
            request.billingAddress.address1,
        }
      : {}),

    ...(request.billingAddress?.address2
      ? {
          Address2:
            request.billingAddress.address2,
        }
      : {}),

    ...(request.billingAddress?.postalCode
      ? {
          PostalCode:
            request.billingAddress.postalCode,
        }
      : {}),

    ...(request.billingAddress?.city
      ? {
          City:
            request.billingAddress.city,
        }
      : {}),

    VATIncluded: true,

    ProductDocumentDetails:
      request.lines.map(
        (line, index) => ({
          Row: index + 1,
          RowType: 0,

          ProductID:
            fiscal.productId,

          WharehouseID:
            fiscal.warehouseId,

          Name:
            line.description,

          Notes:
            line.sku ?? undefined,

          AddedWithVATIncluded:
            true,

          /*
           * MDTech prices are gross / VAT included.
           * WINTOUCH derives taxable base and VAT.
           */
          UnitPriceWithVAT:
            line.unitPriceCents / 100,

          RowUnitPrice:
            line.unitPriceCents / 100,

          StockUnitFactor: 1,

          VATID:
            fiscal.vatId,

          VATTax:
            fiscal.vatRate,

          ProductDocumentDetailsDimensions: [
            {
              Quantity:
                line.quantity,
            },
          ],
        }),
      ),

    /*
     * WINTOUCH model:
     * FT -> Payments must be empty.
     * FS/FATREC -> payment is represented on the document.
     *
     * Payment-method-specific mapping is deliberately
     * NOT guessed here yet. The configured payment method
     * remains the only permitted method until the real
     * WINTOUCH IDs are mapped.
     */
    Payments: isPaidDocument
      ? [
          {
            PaymentMethodID:
              paymentMethodId!,

            Description:
              "Pagamento encomenda online",

            Amount:
              linesTotal / 100,

            PaymentMethodDate:
              documentDate,
          },
        ]
      : [],
  };

  return payload;
}

export const wintouchInvoiceAdapter: InvoiceProviderAdapter = {
  provider:"wintouch",
  async createInvoice(request) {
    const config = resolveWintouchConfig();
    const fiscal = resolveWintouchFiscalConfig();

    const r = await wintouchRequest({
      config,
      endpoint: "productDocuments",
      method: "POST",
      enterpriseId: fiscal.enterpriseId,
      body: buildWintouchInvoicePayload(request),
    });

    if (r.kind === "ambiguous") {
      throw wintouchAmbiguousError(r.reason);
    }

    if (r.status < 200 || r.status >= 300) {
      throw providerFailure(r.status);
    }

    const profile =
      request.fiscalDocumentKind === "simplified_invoice"
        ? fiscal.simplifiedInvoice
        : request.fiscalDocumentKind === "invoice_receipt"
          ? fiscal.invoiceReceipt
          : fiscal.invoice;

    if (!profile) {
      throw new ProviderError("PROVIDER_UNAVAILABLE", {
        provider: WINTOUCH_PROVIDER_ID,
        internalDetail: "WINTOUCH FT profile is not configured",
      });
    }

    return resultFrom(
      r.body,
      profile.documentSerieId,
    );
  },
  async getDocument(providerDocumentId) { const config=resolveWintouchConfig(); const fiscal=resolveWintouchFiscalConfig(); const r=await wintouchRequest({config,endpoint:"productDocuments",resourceId:providerDocumentId,method:"GET",enterpriseId:fiscal.enterpriseId}); if(r.kind==="ambiguous") throw wintouchAmbiguousError(r.reason); if(r.status<200||r.status>=300) throw providerFailure(r.status); return resultFrom(r.body); },
};
