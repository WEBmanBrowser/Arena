import {
  pgTable, serial, varchar, text, integer, boolean, timestamp, decimal,
  jsonb, index, uniqueIndex
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── USERS & AUTH ─────────────────────────────────────────
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password: varchar("password", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 50 }).notNull().default("customer"),
  phone: varchar("phone", { length: 50 }),
  nif: varchar("nif", { length: 20 }),
  company: varchar("company", { length: 255 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("users_email_idx").on(t.email), index("users_role_idx").on(t.role)]);

// ─── ADDRESSES ────────────────────────────────────────────
export const addresses = pgTable("addresses", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  label: varchar("label", { length: 100 }),
  name: varchar("name", { length: 255 }).notNull(),
  address1: varchar("address1", { length: 500 }).notNull(),
  address2: varchar("address2", { length: 500 }),
  city: varchar("city", { length: 255 }).notNull(),
  postalCode: varchar("postal_code", { length: 20 }).notNull(),
  country: varchar("country", { length: 100 }).notNull().default("Portugal"),
  phone: varchar("phone", { length: 50 }),
  isDefault: boolean("is_default").notNull().default(false),
  isDefaultBilling: boolean("is_default_billing").notNull().default(false),
  isDefaultShipping: boolean("is_default_shipping").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // Partial unique indexes: max 1 default billing and max 1 default shipping per user
  uniqueIndex("addresses_default_billing_unique").on(t.userId).where(sql`is_default_billing = true`),
  uniqueIndex("addresses_default_shipping_unique").on(t.userId).where(sql`is_default_shipping = true`),
]);

// ─── CATEGORIES ───────────────────────────────────────────
export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  description: text("description"),
  parentId: integer("parent_id"),
  image: varchar("image", { length: 500 }),
  icon: varchar("icon", { length: 100 }),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  metaTitle: varchar("meta_title", { length: 255 }),
  metaDescription: text("meta_description"),
  filters: jsonb("filters"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("categories_slug_idx").on(t.slug), index("categories_parent_idx").on(t.parentId)]);

// ─── BRANDS ───────────────────────────────────────────────
export const brands = pgTable("brands", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  logo: varchar("logo", { length: 500 }),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── PRODUCTS ─────────────────────────────────────────────
export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 500 }).notNull(),
  slug: varchar("slug", { length: 500 }).notNull().unique(),
  sku: varchar("sku", { length: 100 }).unique(),
  ean: varchar("ean", { length: 50 }),
  brandId: integer("brand_id").references(() => brands.id),
  categoryId: integer("category_id").references(() => categories.id),
  shortDescription: text("short_description"),
  description: text("description"),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  comparePrice: decimal("compare_price", { precision: 10, scale: 2 }),
  costPrice: decimal("cost_price", { precision: 10, scale: 2 }),
  vatRate: decimal("vat_rate", { precision: 5, scale: 2 }).notNull().default("23.00"),
  stock: integer("stock").notNull().default(0),
  minStock: integer("min_stock").notNull().default(0),
  reservedStock: integer("reserved_stock").notNull().default(0),
  storeStock: integer("store_stock").notNull().default(0),
  warehouseStock: integer("warehouse_stock").notNull().default(0),
  weight: decimal("weight", { precision: 8, scale: 2 }),
  dimensions: varchar("dimensions", { length: 100 }),
  images: jsonb("images").$type<string[]>().default([]),
  attributes: jsonb("attributes").$type<Record<string, string>>().default({}),
  tags: jsonb("tags").$type<string[]>().default([]),
  isActive: boolean("is_active").notNull().default(true),
  isFeatured: boolean("is_featured").notNull().default(false),
  isService: boolean("is_service").notNull().default(false),
  allowPreorder: boolean("allow_preorder").notNull().default(false),
  metaTitle: varchar("meta_title", { length: 255 }),
  metaDescription: text("meta_description"),
  viewCount: integer("view_count").notNull().default(0),
  soldCount: integer("sold_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("products_slug_idx").on(t.slug),
  index("products_category_idx").on(t.categoryId),
  index("products_brand_idx").on(t.brandId),
  index("products_active_idx").on(t.isActive),
  index("products_featured_idx").on(t.isFeatured),
  uniqueIndex("products_ean_unique").on(t.ean).where(sql`ean IS NOT NULL`),
]);

// ─── PRODUCT COMPATIBILITY ──────────────────────────────
export const productCompatibility = pgTable("product_compatibility", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  compatibleProductId: integer("compatible_product_id").notNull().references(() => products.id),
  relationType: varchar("relation_type", { length: 50 }).notNull().default("compatible"),
});

// ─── ORDERS ──────────────────────────────────────────────
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  orderNumber: varchar("order_number", { length: 50 }).notNull().unique(),
  userId: integer("user_id").references(() => users.id),
  guestEmail: varchar("guest_email", { length: 255 }),
  guestName: varchar("guest_name", { length: 255 }),
  guestPhone: varchar("guest_phone", { length: 50 }),
  status: varchar("status", { length: 50 }).notNull().default("pending_payment"),
  subtotal: decimal("subtotal", { precision: 10, scale: 2 }).notNull(),
  shipping: decimal("shipping", { precision: 10, scale: 2 }).notNull().default("0.00"),
  discount: decimal("discount", { precision: 10, scale: 2 }).notNull().default("0.00"),
  vat: decimal("vat", { precision: 10, scale: 2 }).notNull().default("0.00"),
  total: decimal("total", { precision: 10, scale: 2 }).notNull(),
  paymentMethod: varchar("payment_method", { length: 100 }),
  paymentStatus: varchar("payment_status", { length: 50 }).notNull().default("pending"),
  shippingMethod: varchar("shipping_method", { length: 100 }),
  deliveryType: varchar("delivery_type", { length: 50 }).notNull().default("shipping"),
  couponCode: varchar("coupon_code", { length: 100 }),
  nif: varchar("nif", { length: 20 }),
  companyName: varchar("company_name", { length: 255 }),
  billingAddress: jsonb("billing_address"),
  shippingAddress: jsonb("shipping_address"),
  notes: text("notes"),
  trackingNumber: varchar("tracking_number", { length: 255 }),
  reservationExpiresAt: timestamp("reservation_expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("orders_user_idx").on(t.userId), index("orders_status_idx").on(t.status)]);

export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id),
  productId: integer("product_id").references(() => products.id),
  productName: varchar("product_name", { length: 500 }).notNull(),
  productSku: varchar("product_sku", { length: 100 }),
  quantity: integer("quantity").notNull(),
  // Financial snapshot — immutable after order creation
  unitPriceGross: decimal("unit_price_gross", { precision: 10, scale: 2 }).notNull(),
  unitPriceNet: decimal("unit_price_net", { precision: 10, scale: 2 }).notNull(),
  vatRate: decimal("vat_rate", { precision: 5, scale: 2 }).notNull().default("23.00"),
  vatAmount: decimal("vat_amount", { precision: 10, scale: 2 }).notNull().default("0.00"),
  discountAmount: decimal("discount_amount", { precision: 10, scale: 2 }).notNull().default("0.00"),
  lineTotalGross: decimal("line_total_gross", { precision: 10, scale: 2 }).notNull(),
});

// ─── ORDER STATUS HISTORY ─────────────────────────────────
export const orderStatusHistory = pgTable("order_status_history", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id),
  fromStatus: varchar("from_status", { length: 50 }),
  toStatus: varchar("to_status", { length: 50 }).notNull(),
  changedBy: integer("changed_by").references(() => users.id),
  comment: text("comment"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("osh_order_idx").on(t.orderId)]);

// ─── STOCK MOVEMENTS ─────────────────────────────────────
export const stockMovements = pgTable("stock_movements", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  type: varchar("type", { length: 50 }).notNull(), // entry, exit, reserve, release, adjustment, return, rma
  quantity: integer("quantity").notNull(),
  stockBefore: integer("stock_before").notNull(),
  stockAfter: integer("stock_after").notNull(),
  reservedBefore: integer("reserved_before").notNull().default(0),
  reservedAfter: integer("reserved_after").notNull().default(0),
  reason: varchar("reason", { length: 255 }),
  referenceType: varchar("reference_type", { length: 50 }), // order, rma, manual
  referenceId: integer("reference_id"),
  userId: integer("user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("sm_product_idx").on(t.productId), index("sm_type_idx").on(t.type)]);

// ─── COUPONS ─────────────────────────────────────────────
export const coupons = pgTable("coupons", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 100 }).notNull().unique(),
  type: varchar("type", { length: 50 }).notNull().default("percentage"),
  value: decimal("value", { precision: 10, scale: 2 }).notNull(),
  minPurchase: decimal("min_purchase", { precision: 10, scale: 2 }),
  maxUses: integer("max_uses"),
  usedCount: integer("used_count").notNull().default(0),
  maxUsesPerUser: integer("max_uses_per_user").default(1),
  categoryId: integer("category_id").references(() => categories.id),
  isActive: boolean("is_active").notNull().default(true),
  startsAt: timestamp("starts_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── WISHLIST ────────────────────────────────────────────
export const wishlists = pgTable("wishlists", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  productId: integer("product_id").notNull().references(() => products.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── STOCK ALERTS ────────────────────────────────────────
export const stockAlerts = pgTable("stock_alerts", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  productId: integer("product_id").notNull().references(() => products.id),
  notified: boolean("notified").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── RMA ─────────────────────────────────────────────────
export const rmaRequests = pgTable("rma_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  orderId: integer("order_id").references(() => orders.id),
  productId: integer("product_id").references(() => products.id),
  type: varchar("type", { length: 50 }).notNull().default("repair"),
  status: varchar("status", { length: 50 }).notNull().default("requested"),
  reason: varchar("reason", { length: 255 }),
  description: text("description").notNull(),
  attachments: jsonb("attachments").$type<string[]>().default([]),
  adminNotes: text("admin_notes"),
  resolution: text("resolution"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── BANNERS ─────────────────────────────────────────────
export const banners = pgTable("banners", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  subtitle: text("subtitle"),
  image: varchar("image", { length: 500 }),
  link: varchar("link", { length: 500 }),
  buttonText: varchar("button_text", { length: 100 }),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── BLOG ────────────────────────────────────────────────
export const blogPosts = pgTable("blog_posts", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 500 }).notNull(),
  slug: varchar("slug", { length: 500 }).notNull().unique(),
  excerpt: text("excerpt"),
  content: text("content").notNull(),
  image: varchar("image", { length: 500 }),
  category: varchar("category", { length: 100 }),
  authorId: integer("author_id").references(() => users.id),
  isPublished: boolean("is_published").notNull().default(false),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── SETTINGS ────────────────────────────────────────────
export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 255 }).notNull().unique(),
  value: text("value"),
  group: varchar("group", { length: 100 }).notNull().default("general"),
});

// ─── PAGES (legal pages, about, etc.) ───────────────────
export const pages = pgTable("pages", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  content: text("content").notNull(),
  isPublished: boolean("is_published").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── SMART SHOPPING ──────────────────────────────────────
export const smartShoppingProfiles = pgTable("smart_shopping_profiles", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  icon: varchar("icon", { length: 100 }),
  description: text("description"),
  questions: jsonb("questions").$type<Array<{question: string; options: string[]}>>().default([]),
  recommendedCategoryIds: jsonb("recommended_category_ids").$type<number[]>().default([]),
  recommendedProductIds: jsonb("recommended_product_ids").$type<number[]>().default([]),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── PC BUILDER RULES ───────────────────────────────────
export const pcBuilderRules = pgTable("pc_builder_rules", {
  id: serial("id").primaryKey(),
  componentType: varchar("component_type", { length: 100 }).notNull(),
  attributeKey: varchar("attribute_key", { length: 100 }).notNull(),
  attributeValue: varchar("attribute_value", { length: 255 }).notNull(),
  compatibleWith: jsonb("compatible_with").$type<Array<{type: string; key: string; value: string}>>().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── AUDIT LOG ───────────────────────────────────────────
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  action: varchar("action", { length: 255 }).notNull(),
  entity: varchar("entity", { length: 100 }),
  entityId: integer("entity_id"),
  details: jsonb("details"),
  ipAddress: varchar("ip_address", { length: 50 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── SUPPLIERS ────────────────────────────────────────────
export const suppliers = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  legalName: varchar("legal_name", { length: 255 }),
  taxId: varchar("tax_id", { length: 50 }),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  website: varchar("website", { length: 500 }),
  contactName: varchar("contact_name", { length: 255 }),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── PRODUCT SUPPLIERS ───────────────────────────────────
export const productSuppliers = pgTable("product_suppliers", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  supplierSku: varchar("supplier_sku", { length: 100 }),
  costPrice: decimal("cost_price", { precision: 10, scale: 2 }),
  lastCostPrice: decimal("last_cost_price", { precision: 10, scale: 2 }),
  leadTimeDays: integer("lead_time_days"),
  isPreferred: boolean("is_preferred").notNull().default(false),
  lastPurchaseAt: timestamp("last_purchase_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("ps_product_idx").on(t.productId),
  index("ps_supplier_idx").on(t.supplierId),
  uniqueIndex("ps_product_supplier_unique").on(t.productId, t.supplierId),
  uniqueIndex("ps_preferred_unique").on(t.productId).where(sql`is_preferred = true`),
]);

// ─── PRODUCT IMAGES ──────────────────────────────────────
export const productImages = pgTable("product_images", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  storageKey: varchar("storage_key", { length: 500 }).notNull(),
  publicUrl: varchar("public_url", { length: 1000 }),
  altText: varchar("alt_text", { length: 500 }),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: boolean("is_primary").notNull().default(false),
  mimeType: varchar("mime_type", { length: 100 }),
  fileSize: integer("file_size"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("pi_product_idx").on(t.productId),
  uniqueIndex("pi_primary_unique").on(t.productId).where(sql`is_primary = true`),
]);

// ─── REVIEWS ─────────────────────────────────────────────
export const reviews = pgTable("reviews", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id),
  userId: integer("user_id").references(() => users.id),
  orderId: integer("order_id").references(() => orders.id),
  rating: integer("rating").notNull(),
  title: varchar("title", { length: 255 }),
  comment: text("comment"),
  isApproved: boolean("is_approved").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── PAYMENTS ─────────────────────────────────────────────
export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id),
  provider: varchar("provider", { length: 50 }).notNull().default("pending"),
  method: varchar("method", { length: 50 }).notNull().default("pending"),
  providerReference: varchar("provider_reference", { length: 255 }),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("EUR"),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  paidAt: timestamp("paid_at"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("payments_order_idx").on(t.orderId), index("payments_status_idx").on(t.status)]);

// ─── EMAIL NOTIFICATIONS ──────────────────────────────────
export const emailNotifications = pgTable("email_notifications", {
  id: serial("id").primaryKey(),
  eventKey: varchar("event_key", { length: 255 }).unique(),
  type: varchar("type", { length: 100 }).notNull(),
  recipient: varchar("recipient", { length: 255 }).notNull(),
  subject: varchar("subject", { length: 500 }),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  referenceType: varchar("reference_type", { length: 50 }),
  referenceId: integer("reference_id"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── SHIPPING METHODS ─────────────────────────────────────
export const shippingMethods = pgTable("shipping_methods", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  type: varchar("type", { length: 50 }).notNull(), // store_pickup, home_delivery
  price: decimal("price", { precision: 10, scale: 2 }).notNull().default("0.00"),
  freeAbove: decimal("free_above", { precision: 10, scale: 2 }),
  estimatedDays: varchar("estimated_days", { length: 50 }),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── PAYMENT / DELIVERY ENUM VALUES (B.2.1) ──────────────
// The columns are varchar for historical reasons; these constants are the
// single source of truth for valid values (used by validation, admin UI, tests).
export const PAYMENT_STATUSES = ["pending", "paid", "cancelled", "expired", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const DELIVERY_TYPES = ["shipping", "pickup"] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

// ─── B.2.2: CUSTOMER NOTES (staff internal notes, never customer-visible) ──
export const customerNotes = pgTable("customer_notes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  authorUserId: integer("author_user_id").notNull().references(() => users.id),
  note: text("note").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at"),
}, (t) => [
  index("customer_notes_user_idx").on(t.userId),
  index("customer_notes_author_idx").on(t.authorUserId),
]);

// ─── P1: RATE LIMITING (fixed window, Postgres-backed) ───
// Works on Cloudflare Workers (no memory between requests).
export const rateLimits = pgTable("rate_limits", {
  id: serial("id").primaryKey(),
  /** Composite key, e.g. "login:ip:1.2.3.4" or "forgot:email:x@y.z" */
  key: varchar("key", { length: 255 }).notNull().unique(),
  count: integer("count").notNull().default(0),
  windowStart: timestamp("window_start").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
}, (t) => [index("rate_limits_expires_idx").on(t.expiresAt)]);

// ─── P1: PASSWORD RESET TOKENS (sha256-hashed, single-use) ──
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** sha256 hex of the raw token — raw token is NEVER stored */
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("password_reset_tokens_user_idx").on(t.userId)]);

// ─── VALID ORDER STATUSES ─────────────────────────────────
export const ORDER_STATUSES = [
  "pending_payment", "paid", "processing", "ready_for_pickup",
  "shipped", "delivered", "cancelled", "expired", "refunded",
  "return_requested", "returned",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Valid transitions map
export const ORDER_TRANSITIONS: Record<string, string[]> = {
  pending_payment: ["paid", "cancelled", "expired"],
  paid: ["processing", "cancelled", "refunded"],
  processing: ["ready_for_pickup", "shipped", "cancelled"],
  ready_for_pickup: ["delivered", "cancelled"],
  shipped: ["delivered", "return_requested"],
  delivered: ["return_requested"],
  return_requested: ["returned", "delivered"],
  returned: ["refunded"],
  cancelled: [],
  expired: [],
  refunded: [],
};

// ─── RMA STATUSES ─────────────────────────────────────────
export const RMA_STATUSES = [
  "requested", "under_review", "approved", "rejected",
  "received", "analysis", "repair", "replacement",
  "refund", "completed", "cancelled",
] as const;
export type RmaStatus = (typeof RMA_STATUSES)[number];
