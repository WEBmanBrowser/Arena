import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser, isAdmin } from "@/lib/auth";
import { createAuditLog } from "@/lib/audit";
import {
  ensureDefaultShippingConfiguration,
  getFreeShippingSettings,
  listShippingClasses,
  updateFreeShippingSettings,
  updateShippingClass,
} from "@/lib/shipping-rates";

export async function GET() {
  await ensureDefaultShippingConfiguration();
  const all = await db.select().from(settings);
  const map: Record<string, string> = {};
  for (const s of all) map[s.key] = s.value || "";
  const shippingClasses = await listShippingClasses(true);
  const freeShipping = await getFreeShippingSettings();
  return NextResponse.json({ settings: map, shippingClasses, freeShipping });
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !isAdmin(user.role)) return NextResponse.json({ error: "Não autorizado" }, { status: 403 });

  const body = await req.json();

  if (body?.shippingConfig) {
    const cfg = body.shippingConfig;
    if (Array.isArray(cfg.classes)) {
      for (const cls of cfg.classes) {
        await updateShippingClass({
          id: Number(cls.id),
          displayName: String(cls.displayName || "").slice(0, 100),
          rateCents: Number(cls.rateCents),
          priority: Number(cls.priority),
          isActive: Boolean(cls.isActive),
          notes: cls.notes == null ? null : String(cls.notes).slice(0, 1000),
        });
      }
    }
    if (cfg.freeShipping) {
      await updateFreeShippingSettings({
        enabled: Boolean(cfg.freeShipping.enabled),
        thresholdCents: Number(cfg.freeShipping.thresholdCents),
      });
    }
    await createAuditLog({
      userId: user.id,
      action: "shipping_config_updated",
      entity: "settings",
      details: {
        classIds: Array.isArray(cfg.classes) ? cfg.classes.map((c: { id: unknown }) => Number(c.id)) : [],
        freeShippingEnabled: cfg.freeShipping ? Boolean(cfg.freeShipping.enabled) : undefined,
        freeShippingThresholdCents: cfg.freeShipping ? Number(cfg.freeShipping.thresholdCents) : undefined,
      },
      ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    });
    return NextResponse.json({ ok: true });
  }

  for (const [key, value] of Object.entries(body)) {
    const [existing] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (existing) {
      await db.update(settings).set({ value: String(value) }).where(eq(settings.key, key));
    } else {
      await db.insert(settings).values({ key, value: String(value), group: "general" });
    }
  }
  return NextResponse.json({ ok: true });
}
