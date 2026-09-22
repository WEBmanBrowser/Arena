import {
  describe,
  expect,
  it,
} from "vitest";

import {
  __wintouchEntityResolverTestUtils,
  buildWintouchEntityPayload,
  resolveOrCreateWintouchEntity,
} from "./entity-resolver";
import type { WintouchResponse } from "./client";

const ENV = {
  WINTOUCH_API_BASE_URL: "https://tenant.example.com",
  WINTOUCH_API_KEY: "test-key",
  WINTOUCH_FS_DOCUMENT_TYPE_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  WINTOUCH_FS_DOCUMENT_SERIE_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  WINTOUCH_FR_DOCUMENT_TYPE_ID: "12121212-1212-4121-8121-121212121212",
  WINTOUCH_FR_DOCUMENT_SERIE_ID: "34343434-3434-4343-8343-343434343434",
  WINTOUCH_SECTOR_ID: "33333333-3333-4333-8333-333333333333",
  WINTOUCH_WORKSTATION_ID: "44444444-4444-4444-8444-444444444444",
  WINTOUCH_ENTERPRISE_ID: "99999999-9999-4999-8999-999999999999",
  WINTOUCH_CURRENCY_ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  WINTOUCH_COUNTRY_ID: "abababab-abab-4bab-8bab-abababababab",
  WINTOUCH_VAT_ID: "66666666-6666-4666-8666-666666666666",
  WINTOUCH_VAT_RATE: "23",
  WINTOUCH_SAVE_MODE: "0",
  WINTOUCH_PRODUCT_ID: "77777777-7777-4777-8777-777777777777",
  WINTOUCH_WAREHOUSE_ID: "88888888-8888-4888-8888-888888888888",
};

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const old = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    return await fn();
  } finally {
    process.env = old;
  }
}

describe("WINTOUCH entity resolver", () => {
  const { normalizeVatNumber, parseEntityLookupBody } =
    __wintouchEntityResolverTestUtils;

  it("normalizes a Portuguese NIF", () => {
    expect(
      normalizeVatNumber("123456789"),
    ).toBe("123456789");
  });

  it("removes the PT prefix", () => {
    expect(
      normalizeVatNumber("PT123456789"),
    ).toBe("123456789");
  });

  it("removes surrounding spaces", () => {
    expect(
      normalizeVatNumber(" 123456789 "),
    ).toBe("123456789");
  });

  it("rejects an invalid NIF shape", () => {
    expect(
      normalizeVatNumber("123"),
    ).toBeNull();

    expect(
      normalizeVatNumber("ABC123456"),
    ).toBeNull();
  });

  it("accepts missing NIF as unresolved", () => {
    expect(
      normalizeVatNumber(undefined),
    ).toBeNull();

    expect(
      normalizeVatNumber(null),
    ).toBeNull();

    expect(
      normalizeVatNumber(""),
    ).toBeNull();
  });

  it("parses the list returned by entities/by_vat", () => {
    expect(parseEntityLookupBody([{
      ID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      VATNumber: "123456789",
      Name: "Cliente",
    }], "123456789")).toEqual({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      vatNumber: "123456789",
      name: "Cliente",
    });
  });

  it("does not accept an entity returned for a different NIF", () => {
    expect(parseEntityLookupBody([{
      ID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      VATNumber: "987654321",
    }], "123456789")).toBeNull();
  });

  it("fails closed when the same NIF resolves to multiple entities", () => {
    expect(() => parseEntityLookupBody([
      { ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", VATNumber: "123456789" },
      { ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", VATNumber: "123456789" },
    ], "123456789")).toThrow("WINTOUCH_ENTITY_LOOKUP_NOT_UNIQUE");
  });

  it("builds a deterministic customer payload from checkout data", () => {
    const payload = buildWintouchEntityPayload({
      vatNumber: "PT123456789",
      name: "Cliente Teste",
      email: "cliente@example.test",
      address: {
        address1: "Rua Um",
        postalCode: "4740-000",
        city: "Esposende",
      },
    }, ENV.WINTOUCH_COUNTRY_ID, ENV.WINTOUCH_CURRENCY_ID);

    expect(payload).toEqual(expect.objectContaining({
      Code: "123456789",
      Name: "Cliente Teste",
      VATNumber: "123456789",
      IsClient: true,
      Enabled: true,
      CountryID: ENV.WINTOUCH_COUNTRY_ID,
    }));
    expect(payload.EntityAddresses).toEqual([
      expect.objectContaining({
        Address1: "Rua Um",
        PostalCode: "4740-000",
        City: "Esposende",
        IsMainAddress: true,
      }),
    ]);
  });

  it("creates once and resolves the entity again by the exact NIF", () => withEnv(async () => {
    const responses: WintouchResponse[] = [
      { kind: "ok", status: 200, body: [] },
      { kind: "ok", status: 201, body: { ID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } },
      { kind: "ok", status: 200, body: [{
        ID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        VATNumber: "123456789",
        Name: "Cliente Teste",
      }] },
    ];
    const methods: string[] = [];
    const entity = await resolveOrCreateWintouchEntity({
      vatNumber: "123456789",
      name: "Cliente Teste",
    }, async (options) => {
      methods.push(options.method);
      return responses.shift()!;
    });

    expect(methods).toEqual(["GET", "POST", "GET"]);
    expect(entity.id).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  }));

  it("reconciles an ambiguous create without repeating the POST", () => withEnv(async () => {
    const responses: WintouchResponse[] = [
      { kind: "ok", status: 200, body: [] },
      { kind: "ambiguous", reason: "timeout" },
      { kind: "ok", status: 200, body: [{
        ID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        VATNumber: "123456789",
      }] },
    ];
    const methods: string[] = [];
    const entity = await resolveOrCreateWintouchEntity({
      vatNumber: "123456789",
      name: "Cliente Teste",
    }, async (options) => {
      methods.push(options.method);
      return responses.shift()!;
    });

    expect(methods).toEqual(["GET", "POST", "GET"]);
    expect(entity.id).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  }));

  it("leaves an unresolved ambiguous create for manual reconciliation", () => withEnv(async () => {
    const responses: WintouchResponse[] = [
      { kind: "ok", status: 200, body: [] },
      { kind: "ambiguous", reason: "network_error" },
      { kind: "ok", status: 200, body: [] },
    ];
    const methods: string[] = [];

    await expect(resolveOrCreateWintouchEntity({
      vatNumber: "123456789",
      name: "Cliente Teste",
    }, async (options) => {
      methods.push(options.method);
      return responses.shift()!;
    })).rejects.toThrow("ambiguous provider outcome");
    expect(methods).toEqual(["GET", "POST", "GET"]);
  }));
});
