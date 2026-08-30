import jwt from "jsonwebtoken";
import bcryptjs from "bcryptjs";
import { cookies } from "next/headers";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

// ─── JWT_SECRET is REQUIRED — no fallback ────────────────
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required. Set it in .env or via Cloudflare secrets.");
  }
  return secret;
}

export async function hashPassword(password: string): Promise<string> {
  return bcryptjs.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcryptjs.compare(password, hash);
}

export function createToken(payload: { userId: number; role: string }): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: "7d" });
}

export function verifyToken(token: string): { userId: number; role: string } | null {
  try {
    return jwt.verify(token, getJwtSecret()) as { userId: number; role: string };
  } catch {
    return null;
  }
}

export type UserRole = "customer" | "staff" | "manager" | "admin";

const ROLE_HIERARCHY: Record<UserRole, number> = {
  customer: 0,
  staff: 1,
  manager: 2,
  admin: 3,
};

/** Check if a role has at least the required permission level */
export function hasRole(userRole: string, requiredRole: UserRole): boolean {
  const userLevel = ROLE_HIERARCHY[userRole as UserRole] ?? -1;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] ?? 999;
  return userLevel >= requiredLevel;
}

/** Check if user has staff-level or above access */
export function isStaff(role: string): boolean {
  return hasRole(role, "staff");
}

/** Check if user has manager-level or above access */
export function isManager(role: string): boolean {
  return hasRole(role, "manager");
}

/** Check if user has admin-level access */
export function isAdmin(role: string): boolean {
  return hasRole(role, "admin");
}

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  phone: string | null;
  nif: string | null;
  company: string | null;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;
    if (!token) return null;
    const payload = verifyToken(token);
    if (!payload) return null;
    const [user] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
    if (!user || !user.isActive) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      phone: user.phone,
      nif: user.nif,
      company: user.company,
    };
  } catch {
    return null;
  }
}

/** Require authentication — returns user or throws JSON response */
export async function requireAuth(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("UNAUTHORIZED");
  }
  return user;
}

/** Require specific role — returns user or throws JSON response */
export async function requireRole(role: UserRole): Promise<AuthUser> {
  const user = await requireAuth();
  if (!hasRole(user.role, role)) {
    throw new Error("FORBIDDEN");
  }
  return user;
}
