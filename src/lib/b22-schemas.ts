/**
 * B.2.2 — Zod validation schemas for customer/account operations.
 */
import { z } from "zod";

// ─── Shared primitives ────────────────────────────────────
export const idSchema = z.number().int().min(1);

// ─── Customer profile ─────────────────────────────────────
const phoneField = z.string().max(50).nullable().optional()
  .transform(v => (v === "" || v === undefined) ? null : v);

const nifField = z.string().max(20).nullable().optional()
  .refine(v => !v || /^\d{9}$/.test(v), "NIF inválido (9 dígitos)")
  .transform(v => (v === "" || v === undefined) ? null : v);

const companyField = z.string().max(255).nullable().optional()
  .transform(v => (v === "" || v === undefined) ? null : v);

export const updateAccountProfileSchema = z.object({
  name: z.string().min(1, "Nome é obrigatório").max(255),
  phone: phoneField,
  nif: nifField,
  company: companyField,
}).strict();

// ─── Addresses ────────────────────────────────────────────
const addressBase = {
  label: z.string().max(100).nullable().optional().transform(v => v?.trim() || null),
  name: z.string().min(1, "Nome do destinatário é obrigatório").max(255),
  address1: z.string().min(1, "Morada é obrigatória").max(500),
  address2: z.string().max(500).nullable().optional().transform(v => v?.trim() || null),
  city: z.string().min(1, "Cidade é obrigatória").max(255),
  postalCode: z.string().min(1, "Código postal é obrigatório").max(20)
    .refine(v => /^\d{4}-\d{3}$/.test(v), "Código postal inválido (NNNN-NNN)"),
  country: z.string().max(100).optional().transform(v => v?.trim() || "Portugal"),
  phone: z.string().max(50).nullable().optional().transform(v => (v === "" || v === undefined) ? null : v),
  setDefaultBilling: z.boolean().optional(),
  setDefaultShipping: z.boolean().optional(),
};

export const createAccountAddressSchema = z.object(addressBase).strict();
export const updateAccountAddressSchema = z.object({
  ...addressBase,
  name: addressBase.name.optional(),
  address1: addressBase.address1.optional(),
  city: addressBase.city.optional(),
  postalCode: addressBase.postalCode.optional(),
}).strict();

// ─── Password ─────────────────────────────────────────────
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Password atual é obrigatória"),
  newPassword: z.string().min(8, "Mínimo 8 caracteres").max(128, "Máximo 128 caracteres"),
}).strict();

// ─── Admin notes ─────────────────────────────────────────
export const createNoteSchema = z.object({
  note: z.string().min(1, "Nota não pode estar vazia").max(5000, "Nota demasiado longa"),
}).strict();

export const updateNoteSchema = z.object({
  note: z.string().min(1, "Nota não pode estar vazia").max(5000, "Nota demasiado longa"),
}).strict();

// ─── Admin customers list query ──────────────────────────
export const adminCustomerQuerySchema = z.object({
  page: z.string().optional().transform(v => {
    if (!v) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  }),
  pageSize: z.string().optional().transform(v => {
    if (!v) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  }),
  search: z.string().max(500).optional(),
  status: z.enum(["all", "active", "disabled", "with_orders", "without_orders"]).optional(),
  registeredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  registeredTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lastOrderFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lastOrderTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(["newest", "oldest", "name_asc", "name_desc", "orders_desc", "spend_desc", "last_order_desc"]).optional(),
}).strict();

// ─── Admin detail query params ──────────────────────────
export const adminCustomerDetailQuerySchema = z.object({
  ordersPage: z.string().optional().transform(v => {
    if (!v) return 1;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 1;
  }),
  ordersPageSize: z.string().optional().transform(v => {
    if (!v) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  }),
}).strict();

// ─── Account orders query ────────────────────────────────
export const accountOrderQuerySchema = z.object({
  page: z.string().optional().transform(v => {
    if (!v) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  }),
  pageSize: z.string().optional().transform(v => {
    if (!v) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  }),
}).strict();
