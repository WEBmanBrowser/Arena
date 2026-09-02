import { db } from "@/db";
import { emailNotifications } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Email sending abstraction compatible with Cloudflare Workers.
 * Uses HTTP API (not SMTP) for sending.
 *
 * Currently supports: Resend (https://resend.com)
 * Add providers by implementing sendViaProvider().
 */

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Send an email via configured provider.
 * Records the attempt in email_notifications table.
 */
export async function sendEmail(params: {
  type: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  referenceType?: string;
  referenceId?: number;
  eventKey?: string;
}): Promise<boolean> {
  // 1. Record notification in DB — atomic deduplication via eventKey UNIQUE constraint
  let notification;
  if (params.eventKey) {
    // INSERT ... ON CONFLICT (event_key) DO NOTHING — atomic, no race condition
    const rows = await db.insert(emailNotifications).values({
      eventKey: params.eventKey,
      type: params.type,
      recipient: params.to,
      subject: params.subject,
      status: "pending",
      referenceType: params.referenceType || null,
      referenceId: params.referenceId || null,
    }).onConflictDoNothing({ target: emailNotifications.eventKey }).returning();
    if (rows.length === 0) return false; // Already exists — do NOT send again
    notification = rows[0];
  } else {
    const [row] = await db.insert(emailNotifications).values({
      eventKey: null,
      type: params.type,
      recipient: params.to,
      subject: params.subject,
      status: "pending",
      referenceType: params.referenceType || null,
      referenceId: params.referenceId || null,
    }).returning();
    notification = row;
  }

  // 2. Attempt to send
  try {
    const apiKey = process.env.EMAIL_API_KEY;
    const fromAddress = process.env.EMAIL_FROM || "noreply@mdtech.pt";

    if (!apiKey) {
      // No email provider configured — log and skip
      console.warn(`[EMAIL] No EMAIL_API_KEY configured. Email "${params.type}" to ${params.to} NOT sent.`);
      await db.update(emailNotifications).set({
        status: "failed",
        lastError: "EMAIL_API_KEY not configured",
        attempts: 1,
      }).where(eq(emailNotifications.id, notification.id));
      return false;
    }

    const payload: EmailPayload = {
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    };

    const sent = await sendViaResend(apiKey, fromAddress, payload);

    await db.update(emailNotifications).set({
      status: sent ? "sent" : "failed",
      sentAt: sent ? new Date() : null,
      attempts: 1,
      lastError: sent ? null : "Provider returned error",
    }).where(eq(emailNotifications.id, notification.id));

    return sent;
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : "Unknown error";
    await db.update(emailNotifications).set({
      status: "failed",
      lastError: errorMsg,
      attempts: 1,
    }).where(eq(emailNotifications.id, notification.id));
    console.error("[EMAIL] Send error:", errorMsg);
    return false;
  }
}

/**
 * Resend provider — HTTP-based, Cloudflare Workers compatible.
 * https://resend.com/docs/api-reference/emails/send-email
 */
async function sendViaResend(apiKey: string, from: string, payload: EmailPayload): Promise<boolean> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("[EMAIL/Resend] Error:", response.status, body);
    return false;
  }
  return true;
}

// ─── HELPERS ──────────────────────────────────────────────

import { users } from "@/db/schema";
import { eq as eqOp } from "drizzle-orm";

/** Resolve the email address for an order's customer. */
export async function getOrderCustomerEmail(order: { userId: number | null; guestEmail: string | null }): Promise<string | null> {
  if (order.guestEmail) return order.guestEmail;
  if (order.userId) {
    const [user] = await db.select({ email: users.email }).from(users).where(eqOp(users.id, order.userId)).limit(1);
    return user?.email ?? null;
  }
  return null;
}

// ─── EMAIL TEMPLATES ──────────────────────────────────────

export function orderCreatedEmail(orderNumber: string, total: string): { subject: string; html: string } {
  return {
    subject: `MD Tech — Encomenda #${orderNumber} registada`,
    html: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#0284c7">MDTech Solutions</h2>
      <p>A sua encomenda <strong>#${orderNumber}</strong> foi registada com sucesso.</p>
      <p>Total: <strong>${total}€</strong></p>
      <p>Estado: <strong>A aguardar pagamento</strong></p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
      <p style="font-size:12px;color:#64748b">MDTech Solutions — Esposende, Portugal</p>
    </div>`,
  };
}

export function orderCancelledEmail(orderNumber: string, reason?: string): { subject: string; html: string } {
  return {
    subject: `MD Tech — Encomenda #${orderNumber} cancelada`,
    html: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#0284c7">MDTech Solutions</h2>
      <p>A sua encomenda <strong>#${orderNumber}</strong> foi cancelada.</p>
      ${reason ? `<p>Motivo: ${reason}</p>` : ""}
      <p>Se tiver questões, não hesite em contactar-nos.</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
      <p style="font-size:12px;color:#64748b">MDTech Solutions — Esposende, Portugal</p>
    </div>`,
  };
}

export function orderExpiredEmail(orderNumber: string): { subject: string; html: string } {
  return {
    subject: `MD Tech — Encomenda #${orderNumber} expirada`,
    html: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#0284c7">MDTech Solutions</h2>
      <p>A sua encomenda <strong>#${orderNumber}</strong> expirou por falta de pagamento.</p>
      <p>Os artigos reservados foram libertados. Pode fazer uma nova encomenda a qualquer momento.</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
      <p style="font-size:12px;color:#64748b">MDTech Solutions — Esposende, Portugal</p>
    </div>`,
  };
}

export function orderPaidEmail(orderNumber: string): { subject: string; html: string } {
  return {
    subject: `MD Tech — Pagamento confirmado #${orderNumber}`,
    html: `<div style="font-family:system-ui;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#0284c7">MDTech Solutions</h2>
      <p>O pagamento da sua encomenda <strong>#${orderNumber}</strong> foi confirmado.</p>
      <p>A sua encomenda será processada em breve.</p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
      <p style="font-size:12px;color:#64748b">MDTech Solutions — Esposende, Portugal</p>
    </div>`,
  };
}
