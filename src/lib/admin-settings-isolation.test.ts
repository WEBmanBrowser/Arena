/**
 * Generic /api/admin/settings isolation from Eupago-managed keys.
 *
 * The generic endpoint predates Backoffice Eupago management: its GET is
 * anonymous and returns every row, and its PUT writes any key. Eupago keys
 * (`eupago_*`) must therefore be unreachable through it in both directions —
 * all Eupago management goes exclusively through the dedicated
 * /api/admin/settings/eupago routes (encryption + validation + audit).
 *
 * DB-backed (runs under scripts/test-runner.cjs with embedded Postgres).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { inArray } from "drizzle-orm";

const getCurrentUserMock = vi.fn();

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => getCurrentUserMock() };
});

import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/admin/settings/route";

const NORMAL_KEY = "isolation_normal_key";
const NORMAL_KEY_2 = "isolation_normal_key_2";
const EUPAGO_KEYS = ["eupago_api_key", "eupago_isolation_probe", "eupago_webhook_endpoint"];
const ALL_KEYS = [NORMAL_KEY, NORMAL_KEY_2, ...EUPAGO_KEYS];

function admin() {
  return { id: 990045, email: "iso-admin@test.local", name: "ISO", role: "admin" };
}

function putReq(body: unknown) {
  return new NextRequest("http://localhost/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readValues(): Promise<Map<string, string>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, ALL_KEYS));
  return new Map(rows.map((r) => [r.key, r.value ?? ""]));
}

beforeEach(async () => {
  getCurrentUserMock.mockReset();
  getCurrentUserMock.mockReturnValue(admin());
  await db.delete(settings).where(inArray(settings.key, ALL_KEYS));
});

afterEach(async () => {
  await db.delete(settings).where(inArray(settings.key, ALL_KEYS));
});

describe("generic /api/admin/settings Eupago isolation", () => {
  it("GET omits eupago_* but keeps a normal setting", async () => {
    await db.insert(settings).values([
      { key: NORMAL_KEY, value: "normal-value", group: "general" },
      { key: "eupago_api_key", value: "enc:v1:fake-ciphertext-envelope", group: "eupago" },
      { key: "eupago_webhook_endpoint", value: "https://x.example/hook", group: "eupago" },
    ]);
    const res = await settingsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings[NORMAL_KEY]).toBe("normal-value");
    expect(body.settings).not.toHaveProperty("eupago_api_key");
    expect(body.settings).not.toHaveProperty("eupago_webhook_endpoint");
    expect(Object.keys(body.settings).some((k: string) => k.startsWith("eupago_"))).toBe(false);
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain("fake-ciphertext-envelope");
    expect(dumped).not.toContain("https://x.example/hook");
  });

  it("GET still works anonymously for non-Eupago settings (behavior preserved)", async () => {
    getCurrentUserMock.mockReturnValue(null);
    await db.insert(settings).values({ key: NORMAL_KEY, value: "v", group: "general" });
    const res = await settingsGET();
    expect(res.status).toBe(200);
    expect((await res.json()).settings[NORMAL_KEY]).toBe("v");
  });

  it("PUT with only eupago_* => 400 and no write", async () => {
    const res = await settingsPUT(putReq({ eupago_api_key: "attacker-plaintext" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "EUPAGO_MANAGED_KEY" });
    expect((await readValues()).has("eupago_api_key")).toBe(false);
  });

  it("PUT mixed {normal, eupago_*} => 400 with ZERO writes including the normal one", async () => {
    const res = await settingsPUT(
      putReq({ [NORMAL_KEY]: "should-not-persist", eupago_webhook_endpoint: "https://evil.example" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "EUPAGO_MANAGED_KEY" });
    const values = await readValues();
    expect(values.has(NORMAL_KEY)).toBe(false);
    expect(values.has("eupago_webhook_endpoint")).toBe(false);
  });

  it("pre-existing Eupago value stays byte-identical after a blocked attempt", async () => {
    const original = "enc:v1:original-envelope-bytes";
    await db
      .insert(settings)
      .values({ key: "eupago_api_key", value: original, group: "eupago" })
      .onConflictDoNothing();
    const res = await settingsPUT(putReq({ eupago_api_key: "corrupted" }));
    expect(res.status).toBe(400);
    const values = await readValues();
    expect(values.get("eupago_api_key")).toBe(original);
  });

  it("PUT with only normal settings keeps previous behavior (insert + update)", async () => {
    const insert = await settingsPUT(putReq({ [NORMAL_KEY]: "one", [NORMAL_KEY_2]: "two" }));
    expect(insert.status).toBe(200);
    expect(await insert.json()).toEqual({ ok: true });
    expect((await readValues()).get(NORMAL_KEY)).toBe("one");
    const update = await settingsPUT(putReq({ [NORMAL_KEY]: "one-updated" }));
    expect(update.status).toBe(200);
    const values = await readValues();
    expect(values.get(NORMAL_KEY)).toBe("one-updated");
    expect(values.get(NORMAL_KEY_2)).toBe("two");
  });
});
