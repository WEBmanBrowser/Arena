/**
 * Zod validation schemas + GTIN/EAN + helpers.
 * Uses Zod 4 syntax.
 */
import { z } from "zod";

// ─── GTIN / EAN ────────────────────────────────────────────

export function isValidGTIN(value: string): boolean {
  if (!/^\d{8}$|^\d{13}$|^\d{14}$/.test(value)) return false;
  const digits = value.split("").map(Number);
  const check = digits.pop()!;
  if (digits.length % 2 !== 0) digits.unshift(0);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    sum += digits[i] * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10 === check;
}

// ─── MONEY SCHEMA ──────────────────────────────────────────

/**
 * Strict monetary string regex: digits, optional dot, max 2 decimal places.
 * Rejects: "10abc", "12.34abc", "-1", "NaN", "Infinity", "10.999"
 */
const MONEY_REGEX = /^\d+(\.\d{1,2})?$/;

/** Validates a monetary string: strict format, >= 0 */
const moneyString = z.string().refine((v) => MONEY_REGEX.test(v), "Valor monetário inválido");

/** Optional money: null/undefined/empty or valid money string */
const optionalMoney = z.string().nullable().optional().refine((v) => {
  if (v === null || v === undefined || v === "") return true;
  return MONEY_REGEX.test(v);
}, "Valor monetário inválido");

/** VAT rate: numeric string, 0-100 */
const vatRateString = z.string().optional().refine((v) => {
  if (!v) return true;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return false;
  const n = parseFloat(v);
  return n >= 0 && n <= 100;
}, "Taxa IVA inválida");

// ─── PRODUCTS ──────────────────────────────────────────────

export const createProductSchema = z.object({
  name: z.string().min(1).max(500),
  sku: z.string().min(1).max(100),
  ean: z.string().nullable().optional(),
  price: moneyString,
  vatRate: vatRateString,
  brandId: z.number().nullable().optional(),
  categoryId: z.number().nullable().optional(),
  shortDescription: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  comparePrice: optionalMoney,
  costPrice: optionalMoney,
  stock: z.number().int().min(0).optional(),
  minStock: z.number().int().min(0).optional(),
  weight: z.string().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  images: z.array(z.string()).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  isService: z.boolean().optional(),
  allowPreorder: z.boolean().optional(),
  metaTitle: z.string().nullable().optional(),
  metaDescription: z.string().nullable().optional(),
  slug: z.string().optional(),
});

export const updateProductSchema = z.object({
  id: z.number().int().min(1),
  name: z.string().min(1).max(500).optional(),
  sku: z.string().min(1).max(100).optional(),
  ean: z.string().nullable().optional(),
  price: moneyString.optional(),
  vatRate: vatRateString,
  brandId: z.number().nullable().optional(),
  categoryId: z.number().nullable().optional(),
  shortDescription: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  comparePrice: optionalMoney,
  costPrice: optionalMoney,
  minStock: z.number().int().min(0).optional(),
  weight: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  slug: z.string().optional(),
  metaTitle: z.string().nullable().optional(),
  metaDescription: z.string().nullable().optional(),
});

// ─── SUPPLIERS ─────────────────────────────────────────────

const supplierFields = {
  name: z.string().min(1).max(255),
  legalName: z.string().max(255).nullable().optional(),
  taxId: z.string().max(50).nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal("")).or(z.literal(null)),
  phone: z.string().max(50).nullable().optional(),
  website: z.string().url().nullable().optional().or(z.literal("")).or(z.literal(null)),
  contactName: z.string().max(255).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  isActive: z.boolean().optional(),
};

/** For backward compatibility — same as createSupplierSchema */
export const supplierSchema = z.object(supplierFields);
export const createSupplierSchema = z.object(supplierFields);
export const updateSupplierSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  legalName: z.string().max(255).nullable().optional(),
  taxId: z.string().max(50).nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal("")).or(z.literal(null)),
  phone: z.string().max(50).nullable().optional(),
  website: z.string().url().nullable().optional().or(z.literal("")).or(z.literal(null)),
  contactName: z.string().max(255).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  isActive: z.boolean().optional(),
}).refine(
  (data) => Object.values(data).some(v => v !== undefined),
  "Pelo menos um campo deve ser fornecido"
);

// ─── PRODUCT SUPPLIERS ─────────────────────────────────────

export const createProductSupplierSchema = z.object({
  supplierId: z.number().int().min(1),
  supplierSku: z.string().max(100).nullable().optional(),
  costPrice: z.union([
    z.number().min(0),
    z.string().refine(v => MONEY_REGEX.test(v), "Custo inválido"),
    z.null(),
  ]).optional(),
  leadTimeDays: z.number().int().min(0).nullable().optional(),
  isPreferred: z.boolean().optional(),
});

export const updateProductSupplierSchema = z.object({
  psId: z.number().int().min(1),
  supplierSku: z.string().max(100).nullable().optional(),
  costPrice: z.union([
    z.number().min(0),
    z.string().refine(v => MONEY_REGEX.test(v), "Custo inválido"),
    z.null(),
  ]).optional(),
  leadTimeDays: z.number().int().min(0).nullable().optional(),
  isPreferred: z.boolean().optional(),
});

// ─── STOCK ─────────────────────────────────────────────────

export const stockAdjustmentSchema = z.object({
  productId: z.number().int().min(1),
  quantity: z.number().int().refine(v => v !== 0, "Quantidade não pode ser zero"),
  type: z.string().min(1),
  reason: z.string().max(255).optional(),
});

// ─── BULK ──────────────────────────────────────────────────

export const bulkActionSchema = z.object({
  ids: z.array(z.number().int().min(1)).min(1),
  action: z.string().min(1),
  value: z.union([z.number(), z.string(), z.boolean()]).optional(),
});

export const bulkPriceSchema = z.object({
  ids: z.array(z.number().int().min(1)).min(1),
  operation: z.string().min(1),
  value: z.number().min(0),
});

// ─── HELPERS ───────────────────────────────────────────────

/** Validate and return parsed data or structured error */
export function validate<T>(schema: z.ZodType<T>, data: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  const issues = result.error?.issues || [];
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const path = issue.path?.join(".") || "unknown";
    fields[path] = issue.message || "Invalid";
  }
  const msg = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("; ") || "Dados inválidos";
  return { success: false, error: msg };
}

/** Detect category cycle */
export function wouldCreateCategoryCycle(
  categoryId: number,
  newParentId: number | null,
  categories: Array<{ id: number; parentId: number | null }>
): boolean {
  if (!newParentId) return false;
  if (categoryId === newParentId) return true;
  let current: number | null = newParentId;
  const visited = new Set<number>();
  while (current) {
    if (current === categoryId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    const parent = categories.find(c => c.id === current);
    current = parent?.parentId ?? null;
  }
  return false;
}
