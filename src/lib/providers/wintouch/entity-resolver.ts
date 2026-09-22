import {
  resolveWintouchConfig,
  resolveWintouchFiscalConfig,
} from "./config";

import {
  wintouchRequest,
  type WintouchResponse,
} from "./client";

export type WintouchResolvedEntity = {
  id: string;
  vatNumber?: string;
  name?: string;
};

export type WintouchEntityCreateInput = {
  vatNumber: string;
  name: string;
  email?: string | null;
  address?: {
    address1?: string | null;
    address2?: string | null;
    postalCode?: string | null;
    city?: string | null;
  } | null;
};

type RequestFn = typeof wintouchRequest;

function normalizeVatNumber(
  value: string | null | undefined,
): string | null {
  if (!value) return null;

  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  if (!normalized) return null;

  // Aceitar tanto 123456789 como PT123456789.
  const withoutCountry =
    normalized.startsWith("PT")
      ? normalized.slice(2)
      : normalized;

  if (!/^\d{9}$/.test(withoutCountry)) {
    return null;
  }

  return withoutCountry;
}

function readString(
  value: unknown,
): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function parseEntityLookupBody(
  responseBody: unknown,
  requestedVat: string,
): WintouchResolvedEntity | null {
  const candidates = Array.isArray(responseBody)
    ? responseBody
    : [responseBody];

  const matches = candidates.filter((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const object = candidate as Record<string, unknown>;
    const returnedVat = normalizeVatNumber(
      readString(object.VATNumber) ??
      readString(object.VatNumber) ??
      readString(object.vatNumber),
    );
    return returnedVat === requestedVat;
  }) as Array<Record<string, unknown>>;

  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error("WINTOUCH_ENTITY_LOOKUP_NOT_UNIQUE");
  }

  const body = matches[0];
  const id = readString(body.ID) ?? readString(body.Id) ?? readString(body.id);
  if (!id) throw new Error("WINTOUCH_ENTITY_LOOKUP_MISSING_ID");

  return {
    id,
    vatNumber: readString(body.VATNumber) ?? readString(body.VatNumber) ?? readString(body.vatNumber),
    name: readString(body.Name) ?? readString(body.EntityName) ?? readString(body.name),
  };
}

export function buildWintouchEntityPayload(
  input: WintouchEntityCreateInput,
  countryId: string,
  currencyId: string,
) {
  const vat = normalizeVatNumber(input.vatNumber);
  const name = input.name.trim();
  if (!vat) throw new Error("WINTOUCH_CUSTOMER_NIF_INVALID");
  if (!name) throw new Error("WINTOUCH_CUSTOMER_NAME_REQUIRED");

  const email = input.email?.trim() || null;
  const address1 = input.address?.address1?.trim() || null;
  const address2 = input.address?.address2?.trim() || null;
  const postalCode = input.address?.postalCode?.trim() || null;
  const city = input.address?.city?.trim() || null;
  const hasAddress = Boolean(address1 || address2 || postalCode || city || email);

  return {
    // The tenant has no automatic entity-code sequence. The normalized NIF is
    // deterministic, unique for this integration and safe to reconcile.
    Code: vat,
    Name: name,
    IsClient: true,
    IsOtherDebtor: false,
    Enabled: true,
    CountryID: countryId,
    CurrencyID: currencyId,
    VATNumber: vat,
    ...(email ? {
      EntityContacts: [{ Row: 0, Name: name, Email: email }],
    } : {}),
    ...(hasAddress ? {
      EntityAddresses: [{
        Name: "Morada principal",
        Address1: address1 ?? undefined,
        Address2: address2 ?? undefined,
        PostalCode: postalCode ?? undefined,
        City: city ?? undefined,
        Email: email ?? undefined,
        CountryID: countryId,
        VATNumber: vat,
        IsMainAddress: true,
        IsActive: true,
        CreatedInDocument: false,
      }],
    } : {}),
  };
}

async function lookupEntity(
  vat: string,
  requestFn: RequestFn,
): Promise<WintouchResolvedEntity | null> {
  const config = resolveWintouchConfig();
  const fiscal = resolveWintouchFiscalConfig();
  const response = await requestFn({
    config,
    endpoint: "entities",
    entityVatNumber: vat,
    method: "GET",
    enterpriseId: fiscal.enterpriseId,
  });

  if (response.kind === "ambiguous") throw new Error("WINTOUCH_ENTITY_LOOKUP_AMBIGUOUS");
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`WINTOUCH_ENTITY_LOOKUP_FAILED_${response.status}`);
  }
  if (!response.body || typeof response.body !== "object") {
    throw new Error("WINTOUCH_ENTITY_LOOKUP_INVALID_RESPONSE");
  }
  return parseEntityLookupBody(response.body, vat);
}

export async function resolveWintouchEntityByVat(
  vatNumber: string | null | undefined,
  requestFn: RequestFn = wintouchRequest,
): Promise<WintouchResolvedEntity | null> {
  const vat = normalizeVatNumber(vatNumber);

  if (!vat) {
    return null;
  }

  return lookupEntity(vat, requestFn);
}

export async function resolveOrCreateWintouchEntity(
  input: WintouchEntityCreateInput,
  requestFn: RequestFn = wintouchRequest,
): Promise<WintouchResolvedEntity> {
  const vat = normalizeVatNumber(input.vatNumber);
  if (!vat) throw new Error("WINTOUCH_CUSTOMER_NIF_INVALID");

  const existing = await lookupEntity(vat, requestFn);
  if (existing) return existing;

  const config = resolveWintouchConfig();
  const fiscal = resolveWintouchFiscalConfig();
  const payload = buildWintouchEntityPayload(input, fiscal.countryId, fiscal.currencyId);
  const response: WintouchResponse = await requestFn({
    config,
    endpoint: "entities",
    method: "POST",
    enterpriseId: fiscal.enterpriseId,
    body: payload,
  });

  if (response.kind === "ambiguous") {
    const reconciled = await lookupEntity(vat, requestFn);
    if (reconciled) return reconciled;
    throw new Error("ambiguous provider outcome: entity creation");
  }

  // A concurrent checkout may have created the same VAT between our GET and
  // POST. Reconcile every response before deciding whether creation failed.
  const reconciled = await lookupEntity(vat, requestFn);
  if (reconciled) return reconciled;

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`WINTOUCH_ENTITY_CREATE_FAILED_${response.status}`);
  }
  throw new Error("WINTOUCH_ENTITY_CREATE_NOT_RECONCILED");
}

export const __wintouchEntityResolverTestUtils = {
  normalizeVatNumber,
  parseEntityLookupBody,
};
