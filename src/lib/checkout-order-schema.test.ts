import { describe, expect, it } from "vitest";
import { checkoutOrderSchema } from "@/lib/checkout-order-schema";

const address = {
  name: "Marco Duarte",
  address1: "Rua de Teste 10",
  address2: null,
  city: "Esposende",
  postalCode: "4740-000",
  country: "Portugal",
  phone: "912345678",
};

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    items: [{ productId: 1, quantity: 1 }],
    billingAddress: address,
    shippingAddress: address,
    deliveryType: "shipping",
    paymentMethod: "bank_transfer",
    guestEmail: "cliente@example.com",
    guestName: "Cliente Teste",
    guestPhone: "912345678",
    ...overrides,
  };
}

describe("checkoutOrderSchema", () => {
  it.each(["bank_transfer", "multibanco", "mbway", "card"] as const)(
    "accepts payment method %s",
    (paymentMethod) => {
      expect(checkoutOrderSchema.safeParse(validBody({ paymentMethod })).success).toBe(true);
    },
  );

  it("rejects unsupported payment methods", () => {
    expect(checkoutOrderSchema.safeParse(validBody({ paymentMethod: "cash" })).success).toBe(false);
  });

  it("requires at least one cart item", () => {
    expect(checkoutOrderSchema.safeParse(validBody({ items: [] })).success).toBe(false);
  });

  it("rejects invalid quantities", () => {
    expect(checkoutOrderSchema.safeParse(validBody({
      items: [{ productId: 1, quantity: 101 }],
    })).success).toBe(false);
  });

  it("requires a billing address", () => {
    const body = validBody();
    delete (body as Record<string, unknown>).billingAddress;
    expect(checkoutOrderSchema.safeParse(body).success).toBe(false);
  });

  it("requires a shipping address for shipping", () => {
    expect(checkoutOrderSchema.safeParse(validBody({ shippingAddress: null })).success).toBe(false);
  });

  it("does not require a shipping address for pickup", () => {
    expect(checkoutOrderSchema.safeParse(validBody({
      deliveryType: "pickup",
      shippingAddress: null,
    })).success).toBe(true);
  });

  it("validates Portuguese postal codes", () => {
    expect(checkoutOrderSchema.safeParse(validBody({
      billingAddress: { ...address, postalCode: "4740000" },
    })).success).toBe(false);
  });

  it("accepts an empty optional NIF", () => {
    expect(checkoutOrderSchema.safeParse(validBody({ nif: "" })).success).toBe(true);
  });

  it("rejects a malformed NIF", () => {
    expect(checkoutOrderSchema.safeParse(validBody({ nif: "123" })).success).toBe(false);
  });

  it("normalizes guest email", () => {
    const parsed = checkoutOrderSchema.parse(validBody({
      guestEmail: "  CLIENTE@EXAMPLE.COM  ",
    }));
    expect(parsed.guestEmail).toBe("cliente@example.com");
  });

  it("rejects malformed guest email", () => {
    expect(checkoutOrderSchema.safeParse(validBody({
      guestEmail: "cliente-invalido",
    })).success).toBe(false);
  });

  it("allows MB WAY without guest phone so authenticated identity can be resolved by the route", () => {
    expect(checkoutOrderSchema.safeParse(validBody({
      paymentMethod: "mbway",
      guestPhone: null,
    })).success).toBe(true);
  });

  it("normalizes an MB WAY phone to digits", () => {
    const parsed = checkoutOrderSchema.parse(validBody({
      paymentMethod: "mbway",
      guestPhone: " +351 912 345 678 ",
    }));
    expect(parsed.guestPhone).toBe("351912345678");
  });

  it.each([
    "12345",
    "1234567890123456",
    "abcdefghi",
  ])("rejects invalid MB WAY phone %s", (guestPhone) => {
    expect(checkoutOrderSchema.safeParse(validBody({
      paymentMethod: "mbway",
      guestPhone,
    })).success).toBe(false);
  });

  it("allows card without guest email so authenticated identity can be resolved by the route", () => {
    expect(checkoutOrderSchema.safeParse(validBody({
      paymentMethod: "card",
      guestEmail: null,
    })).success).toBe(true);
  });

  it("accepts MB WAY-compatible phone digits", () => {
    expect(checkoutOrderSchema.safeParse(validBody({
      paymentMethod: "mbway",
      guestPhone: "912345678",
    })).success).toBe(true);
  });
});
