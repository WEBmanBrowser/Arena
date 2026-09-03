/**
 * Shared, dependency-free role helpers.
 *
 * `src/lib/auth.ts` owns the authoritative RBAC logic, but it imports
 * `next/headers` and the database layer, so it cannot be pulled into a client
 * component. This module holds the same hierarchy as pure data so the browser
 * can decide what to *show* (redirects, menu entries) without importing any
 * server-only code.
 *
 * SECURITY: this is presentation-only. Every administrative API keeps
 * enforcing authorization server-side via getCurrentUser() + isStaff/isManager.
 * Hiding a link here never grants or denies access.
 */

/** Roles allowed into the backoffice, mirroring src/app/admin/layout.tsx. */
export const STAFF_ROLES = ["staff", "manager", "admin"] as const;

/** True when the role is staff-level or above (staff, manager, admin). */
export function isStaffRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return (STAFF_ROLES as readonly string[]).includes(role);
}

/** Landing route right after a successful login, based on the user's role. */
export function postLoginRedirect(role: string | null | undefined): string {
  return isStaffRole(role) ? "/admin" : "/conta";
}
