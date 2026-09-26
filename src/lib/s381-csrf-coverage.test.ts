import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.join(process.cwd(), "src", "app", "api");
const UNSAFE_HANDLER = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\([^)]*\)\s*\{/g;

function routeFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

function assertUnsafeHandlersGuarded(file: string) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(UNSAFE_HANDLER)) {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const prologue = source.slice(bodyStart, bodyStart + 240);
    expect(prologue, `${path.relative(process.cwd(), file)} ${match[1]} must start with csrfGuard`).toContain("csrfGuard(");
  }
}

describe("S38.1 CSRF coverage", () => {
  it("guards every state-changing admin route", () => {
    for (const file of routeFiles(path.join(API_ROOT, "admin"))) assertUnsafeHandlersGuarded(file);
  });

  it("guards authenticated customer RMA and wishlist mutations", () => {
    assertUnsafeHandlersGuarded(path.join(API_ROOT, "rma", "route.ts"));
    assertUnsafeHandlersGuarded(path.join(API_ROOT, "wishlist", "route.ts"));
  });

  it("keeps machine-to-machine endpoints outside browser CSRF", () => {
    for (const relative of [
      ["webhooks", "eupago", "route.ts"],
      ["cron", "expire-reservations", "route.ts"],
      ["cron", "refund-maintenance", "route.ts"],
    ]) {
      const source = fs.readFileSync(path.join(API_ROOT, ...relative), "utf8");
      expect(source).not.toContain("csrfGuard(");
    }
  });
});
