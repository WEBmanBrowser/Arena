import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { productImages } from "@/db/schema";
import { eq, and, asc, sql } from "drizzle-orm";
import { getCurrentUser, isStaff, isManager } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import { getR2Bucket, R2StorageProvider } from "@/lib/storage/r2";
import { ALLOWED_MIME_TYPES, MAX_IMAGE_SIZE, validateImageSignature } from "@/lib/storage/types";
import type { StorageProvider } from "@/lib/storage/types";
import { z } from "zod";
import { reorderImages } from "@/lib/services/product-image-service";
import { executeImageAltUpdate, executeImageDelete } from "@/lib/services/admin-operations";

function getStorage(): StorageProvider | null {
  const bucket = getR2Bucket();
  if (!bucket) return null;
  return new R2StorageProvider(bucket, process.env.R2_PUBLIC_URL || "");
}

// ── Zod Schemas for PUT actions ───────────────────────────
const setPrimarySchema = z.object({ action: z.literal("setPrimary"), imageId: z.number().int().min(1) });
const updateAltSchema = z.object({ action: z.literal("updateAlt"), imageId: z.number().int().min(1), altText: z.string().max(500).nullable().optional() });
const reorderItemSchema = z.object({ imageId: z.number().int().min(1), sortOrder: z.number().int().min(0) });
const reorderSchema = z.object({ action: z.literal("reorder"), items: z.array(reorderItemSchema).min(1) });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isStaff(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { id } = await params;
  const images = await db.select().from(productImages).where(eq(productImages.productId, parseInt(id))).orderBy(asc(productImages.sortOrder));
  return NextResponse.json({ images });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { id } = await params;
  const productId = parseInt(id);

  const storage = getStorage();
  if (!storage) return NextResponse.json({ error: "STORAGE_NOT_CONFIGURED" }, { status: 503 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "Ficheiro obrigatório" }, { status: 400 });
  if (!ALLOWED_MIME_TYPES.includes(file.type)) return NextResponse.json({ error: "INVALID_MIME_TYPE" }, { status: 400 });
  if (file.size > MAX_IMAGE_SIZE) return NextResponse.json({ error: "IMAGE_TOO_LARGE" }, { status: 400 });

  const buffer = await file.arrayBuffer();
  if (!validateImageSignature(buffer, file.type)) return NextResponse.json({ error: "INVALID_IMAGE" }, { status: 400 });

  const ext = file.type.split("/")[1] === "jpeg" ? "jpg" : file.type.split("/")[1];
  const storageKey = `products/${productId}/${crypto.randomUUID()}.${ext}`;

  // Correct nextOrder using MAX aggregate
  const [maxRow] = await db.select({ maxOrder: sql<number>`COALESCE(MAX(${productImages.sortOrder}), -1)` }).from(productImages).where(eq(productImages.productId, productId));
  const nextOrder = (maxRow?.maxOrder ?? -1) + 1;

  const existing = await db.select({ id: productImages.id }).from(productImages).where(eq(productImages.productId, productId)).limit(1);
  const isPrimary = existing.length === 0;

  try { await storage.upload(storageKey, buffer, file.type); } catch { return NextResponse.json({ error: "STORAGE_UPLOAD_FAILED" }, { status: 500 }); }

  try {
    const [image] = await db.insert(productImages).values({
      productId, storageKey, publicUrl: storage.getPublicUrl(storageKey),
      altText: formData.get("altText") as string || null,
      sortOrder: nextOrder, isPrimary, mimeType: file.type, fileSize: file.size,
    }).returning();
    await createAuditLog({ userId: user.id, action: "image.uploaded", entity: "product_image", entityId: image.id });
    return NextResponse.json({ image }, { status: 201 });
  } catch (e) {
    try { await storage.delete(storageKey); } catch { /* cleanup best effort */ }
    throw e;
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { id } = await params;
  const productId = parseInt(id);
  const body = await req.json();

  // setPrimary
  const sp = setPrimarySchema.safeParse(body);
  if (sp.success) {
    const [img] = await db.select().from(productImages).where(eq(productImages.id, sp.data.imageId)).limit(1);
    if (!img || img.productId !== productId) return NextResponse.json({ error: "Imagem não encontrada" }, { status: 404 });
    await db.transaction(async (tx) => {
      await tx.update(productImages).set({ isPrimary: false, updatedAt: new Date() }).where(and(eq(productImages.productId, productId), eq(productImages.isPrimary, true)));
      await tx.update(productImages).set({ isPrimary: true, updatedAt: new Date() }).where(eq(productImages.id, sp.data.imageId));
    });
    await createAuditLog({ userId: user.id, action: "image.primary_changed", entity: "product_image", entityId: sp.data.imageId });
    return NextResponse.json({ ok: true });
  }

  // updateAlt — uses operation handler
  const ua = updateAltSchema.safeParse(body);
  if (ua.success) {
    try {
      const newAlt = typeof ua.data.altText === "string" ? ua.data.altText.trim() || null : null;
      const result = await executeImageAltUpdate(user.id, productId, ua.data.imageId, newAlt);
      return NextResponse.json({ ok: true, noOp: !result.changed });
    } catch (e) {
      if ((e as Error).message === "NOT_FOUND") return NextResponse.json({ error: "Imagem não encontrada" }, { status: 404 });
      return NextResponse.json({ error: "Erro interno" }, { status: 500 });
    }
  }

  // reorder — uses service
  const ro = reorderSchema.safeParse(body);
  if (ro.success) {
    try {
      await reorderImages(productId, ro.data.items);
      await createAuditLog({ userId: user.id, action: "image.reordered", entity: "product", entityId: productId });
      return NextResponse.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "OWNERSHIP") return NextResponse.json({ error: "Imagem não encontrada" }, { status: 404 });
      if (msg.startsWith("VALIDATION:")) return NextResponse.json({ error: "VALIDATION_ERROR", details: msg.replace("VALIDATION:", "") }, { status: 400 });
      return NextResponse.json({ error: "Erro interno" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "VALIDATION_ERROR", details: "Ação de imagem inválida" }, { status: 400 });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || !isManager(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });
  const { id } = await params;
  const productId = parseInt(id);
  const body = await req.json() as Record<string, unknown>;
  const imageId = parseInt(body.imageId as string);
  if (!imageId || imageId < 1) return NextResponse.json({ error: "imageId inválido" }, { status: 400 });

  // Use operation handler for delete + audit
  try {
    const storage = getStorage();
    await executeImageDelete(user.id, productId, imageId, storage);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "NOT_FOUND") return NextResponse.json({ error: "Imagem não encontrada" }, { status: 404 });
    if (msg === "STORAGE_NOT_CONFIGURED") return NextResponse.json({ error: msg }, { status: 503 });
    if (msg === "STORAGE_DELETE_FAILED") return NextResponse.json({ error: msg }, { status: 500 });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
