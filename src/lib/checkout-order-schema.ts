import { z } from "zod";

export const CHECKOUT_PAYMENT_METHODS = [
  "bank_transfer",
  "multibanco",
  "mbway",
  "card",
] as const;

export const checkoutPaymentMethodSchema = z.enum(CHECKOUT_PAYMENT_METHODS);

export const checkoutAddressSchema = z.object({
  name: z.string().trim().min(1).max(255),
  address1: z.string().trim().min(1).max(500),
  address2: z.string().trim().max(500).nullable().optional()
    .transform((value) => value || null),
  city: z.string().trim().min(1).max(255),
  postalCode: z.string().trim().regex(/^\d{4}-\d{3}$/),
  country: z.string().trim().min(1).max(100).default("Portugal"),
  phone: z.string().trim().max(50).nullable().optional()
    .transform((value) => value || null),
});

const checkoutItemSchema = z.object({
  productId: z.number().int().min(1),
  quantity: z.number().int().min(1).max(100),
});

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional()
    .transform((value) => value || null);

const optionalNif = z.string()
  .trim()
  .max(20)
  .nullable()
  .optional()
  .refine(
    (value) => !value || /^\d{9}$/.test(value),
    "NIF inválido",
  )
  .transform((value) => value || null);

const optionalEmail = z.string()
  .trim()
  .toLowerCase()
  .max(255)
  .nullable()
  .optional()
  .refine(
    (value) => !value || z.email().safeParse(value).success,
    "Email inválido",
  )
  .transform((value) => value || null);

export const checkoutOrderSchema = z.object({
  items: z.array(checkoutItemSchema).min(1).max(500),
  billingAddress: checkoutAddressSchema,
  shippingAddress: checkoutAddressSchema.nullable().optional(),
  deliveryType: z.enum(["shipping", "pickup"]),
  paymentMethod: checkoutPaymentMethodSchema,
  shippingMethod: optionalText(100),
  couponCode: optionalText(100),
  nif: optionalNif,
  companyName: optionalText(255),
  guestEmail: optionalEmail,
  guestName: optionalText(255),
  guestPhone: optionalText(50),
  notes: optionalText(2000),
}).transform((value) => {
  if (value.paymentMethod !== "mbway" || !value.guestPhone) {
    return value;
  }

  return {
    ...value,
    guestPhone: value.guestPhone.replace(/\D/g, ""),
  };
}).superRefine((value, ctx) => {
  if (value.paymentMethod === "mbway" && value.guestPhone !== null && !/^\d{6,15}$/.test(value.guestPhone)) {
    ctx.addIssue({
      code: "custom",
      path: ["guestPhone"],
      message: "Telefone MB WAY invalido",
    });
  }

  if (value.deliveryType === "shipping" && !value.shippingAddress) {
    ctx.addIssue({
      code: "custom",
      path: ["shippingAddress"],
      message: "Morada de entrega obrigatória",
    });
  }
});

export type CheckoutOrderInput = z.infer<typeof checkoutOrderSchema>;
export type CheckoutPaymentMethod = z.infer<typeof checkoutPaymentMethodSchema>;
