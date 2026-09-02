/**
 * B.5.1 — First-admin bootstrap CLI tests (real PostgreSQL).
 *
 * Covers validation, refusal rules, bcrypt policy, logging hygiene and the
 * real concurrency guarantee (advisory-lock serialized bootstrap).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq, like, sql } from "drizzle-orm";
import bcryptjs from "bcryptjs";
import {
  ADMIN_BOOTSTRAP_LOCK_KEY,
  AdminBootstrapError,
  BCRYPT_ROUNDS,
  createFirstAdmin,
  normalizeEmail,
  validateEmail,
  validatePassword,
} from "@/lib/admin-bootstrap";
import { parseArgs, main as adminCliMain } from "@/scripts/create-admin";

const MARKER = "b51";
const GOOD_PASSWORD = "StrongPassword!123";

/**
 * The bootstrap refuses when ANY admin exists, so the fixture must present a
 * zero-admin database. We snapshot pre-existing admins, park them as
 * "customer" for the duration of the test and restore them afterwards.
 */
let parkedAdminIds: number[] = [];

async function parkExistingAdmins() {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
  parkedAdminIds = rows.map((r) => r.id);
  if (parkedAdminIds.length > 0) {
    await db.execute(sql`UPDATE users SET role = 'customer' WHERE id = ANY(${sql.raw(`ARRAY[${parkedAdminIds.join(",")}]`)})`);
  }
}

async function restoreParkedAdmins() {
  if (parkedAdminIds.length > 0) {
    await db.execute(sql`UPDATE users SET role = 'admin' WHERE id = ANY(${sql.raw(`ARRAY[${parkedAdminIds.join(",")}]`)})`);
    parkedAdminIds = [];
  }
}

async function cleanupFixtures() {
  await db.delete(users).where(like(users.email, `${MARKER}-%`));
}

beforeEach(async () => {
  await cleanupFixtures();
  await parkExistingAdmins();
});

afterEach(async () => {
  await cleanupFixtures();
  await restoreParkedAdmins();
  vi.restoreAllMocks();
});

function email(suffix: string) {
  return `${MARKER}-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

describe("B.5.1 — email handling", () => {
  it("normalizes email consistently (trim + lowercase)", () => {
    expect(normalizeEmail("  Admin@Example.COM ")).toBe("admin@example.com");
    expect(validateEmail(" Admin@Example.com ")).toBe("admin@example.com");
  });

  it("rejects a missing email", () => {
    expect(() => validateEmail(undefined)).toThrowError(AdminBootstrapError);
    try {
      validateEmail("   ");
    } catch (e) {
      expect((e as AdminBootstrapError).code).toBe("EMAIL_REQUIRED");
    }
  });

  it("rejects invalid emails", () => {
    for (const bad of ["nope", "a@b", "a@@b.com", "a b@c.com", "@x.com", "x@.com"]) {
      let code = "";
      try {
        validateEmail(bad);
      } catch (e) {
        code = (e as AdminBootstrapError).code;
      }
      expect(code, `expected ${bad} to be invalid`).toBe("EMAIL_INVALID");
    }
  });
});

describe("B.5.1 — password policy", () => {
  const cases: Array<[string, string]> = [
    ["Sh0rt!aA", "PASSWORD_TOO_SHORT"],
    [`A1!${"a".repeat(200)}`, "PASSWORD_TOO_LONG"],
    ["ALLUPPER123!X", "PASSWORD_MISSING_LOWERCASE"],
    ["alllower123!x", "PASSWORD_MISSING_UPPERCASE"],
    ["NoDigitsHere!x", "PASSWORD_MISSING_DIGIT"],
    ["NoSpecial123abc", "PASSWORD_MISSING_SPECIAL"],
  ];

  it.each(cases)("rejects weak password (%s)", (pw, expected) => {
    let code = "";
    try {
      validatePassword(pw);
    } catch (e) {
      code = (e as AdminBootstrapError).code;
    }
    expect(code).toBe(expected);
  });

  it("rejects a missing password", () => {
    let code = "";
    try {
      validatePassword(undefined);
    } catch (e) {
      code = (e as AdminBootstrapError).code;
    }
    expect(code).toBe("PASSWORD_REQUIRED");
  });

  it("accepts a compliant password", () => {
    expect(validatePassword(GOOD_PASSWORD)).toBe(GOOD_PASSWORD);
  });
});

describe("B.5.1 — creation", () => {
  it("creates the first administrator with role hardcoded to admin", async () => {
    const e = email("create");
    const res = await createFirstAdmin({ email: e, password: GOOD_PASSWORD, name: "Bootstrap Admin" });
    expect(res.role).toBe("admin");

    const [row] = await db.select().from(users).where(eq(users.id, res.id));
    expect(row.role).toBe("admin");
    expect(row.email).toBe(e.toLowerCase());
    expect(row.isActive).toBe(true);
  });

  it("stores a bcrypt hash with the repository policy of 12 rounds and never the plaintext", async () => {
    const e = email("bcrypt");
    const res = await createFirstAdmin({ email: e, password: GOOD_PASSWORD });
    const [row] = await db.select().from(users).where(eq(users.id, res.id));

    expect(row.password).not.toBe(GOOD_PASSWORD);
    expect(row.password.startsWith("$2")).toBe(true);
    expect(row.password.split("$")[2]).toBe(String(BCRYPT_ROUNDS));
    expect(await bcryptjs.compare(GOOD_PASSWORD, row.password)).toBe(true);
    expect(await bcryptjs.compare("wrong-password", row.password)).toBe(false);
  });

  it("does not persist the plaintext password anywhere in the users row", async () => {
    const e = email("plain");
    const res = await createFirstAdmin({ email: e, password: GOOD_PASSWORD });
    const rows = await db.execute(sql`SELECT * FROM users WHERE id = ${res.id}`);
    const serialized = JSON.stringify(rows.rows);
    expect(serialized).not.toContain(GOOD_PASSWORD);
  });

  it("refuses when an administrator already exists", async () => {
    await createFirstAdmin({ email: email("first"), password: GOOD_PASSWORD });
    let code = "";
    try {
      await createFirstAdmin({ email: email("second"), password: GOOD_PASSWORD });
    } catch (e) {
      code = (e as AdminBootstrapError).code;
    }
    expect(code).toBe("ADMIN_ALREADY_EXISTS");
  });

  it("refuses when the requested email already exists", async () => {
    const e = email("dup");
    await db.insert(users).values({ email: e.toLowerCase(), password: "x", name: "Existing", role: "customer" });
    let code = "";
    try {
      await createFirstAdmin({ email: e, password: GOOD_PASSWORD });
    } catch (err) {
      code = (err as AdminBootstrapError).code;
    }
    expect(code).toBe("EMAIL_ALREADY_EXISTS");
    const [row] = await db.select().from(users).where(eq(users.email, e.toLowerCase()));
    expect(row.role).toBe("customer");
  });
});

describe("B.5.1 — concurrency (real PostgreSQL advisory lock)", () => {
  it("uses a fixed documented advisory-lock key", () => {
    expect(ADMIN_BOOTSTRAP_LOCK_KEY).toBe(851_000_001);
  });

  it("two simultaneous bootstraps against a zero-admin DB create exactly one admin", async () => {
    const e1 = email("race-a");
    const e2 = email("race-b");

    const results = await Promise.allSettled([
      createFirstAdmin({ email: e1, password: GOOD_PASSWORD }),
      createFirstAdmin({ email: e2, password: GOOD_PASSWORD }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(((rejected[0] as PromiseRejectedResult).reason as AdminBootstrapError).code).toBe("ADMIN_ALREADY_EXISTS");

    const admins = await db.select().from(users).where(eq(users.role, "admin"));
    expect(admins.filter((a) => a.email.startsWith(`${MARKER}-`))).toHaveLength(1);
  });
});

describe("B.5.1 — CLI surface", () => {
  it("parses --email/--password and --key=value form", () => {
    expect(parseArgs(["--email", "a@b.com", "--password", "P"])).toEqual({ email: "a@b.com", password: "P" });
    expect(parseArgs(["--email=a@b.com", "--password=P"])).toEqual({ email: "a@b.com", password: "P" });
  });

  it("refuses a --role argument (role is fixed to admin)", () => {
    expect(() => parseArgs(["--email", "a@b.com", "--password", "P", "--role", "customer"])).toThrowError(/Unsupported option: --role/);
  });

  it("exits non-zero when --email is missing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await adminCliMain(["--password", GOOD_PASSWORD]);
    expect(code).toBe(2);
    expect(err).toHaveBeenCalled();
  });

  it("exits non-zero when --password is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await adminCliMain(["--email", "a@b.com"])).toBe(2);
  });

  it("never logs the plaintext password, the hash, or environment secrets", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });

    const e = email("cli-log");
    const code = await adminCliMain(["--email", e, "--password", GOOD_PASSWORD]);
    expect(code).toBe(0);

    const output = logged.join("\n");
    expect(output).not.toContain(GOOD_PASSWORD);
    expect(output).not.toContain("$2b$");
    expect(output).not.toContain("$2a$");
    if (process.env.DATABASE_URL) expect(output).not.toContain(process.env.DATABASE_URL);
    for (const k of ["JWT_SECRET", "CRON_SECRET", "EUPAGO_API_KEY"]) {
      const v = process.env[k];
      if (v) expect(output).not.toContain(v);
    }

    const [row] = await db.select().from(users).where(eq(users.email, e.toLowerCase()));
    expect(row.role).toBe("admin");
    expect(output).not.toContain(row.password);
  });

  it("reports refusal with exit code 1 when an admin already exists", async () => {
    await createFirstAdmin({ email: email("cli-first"), password: GOOD_PASSWORD });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await adminCliMain(["--email", email("cli-second"), "--password", GOOD_PASSWORD])).toBe(1);
  });

  it("rejects a weak password at the CLI boundary with exit code 1", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await adminCliMain(["--email", email("cli-weak"), "--password", "weak"])).toBe(1);
    const rows = await db.select().from(users).where(eq(users.role, "admin"));
    expect(rows).toHaveLength(0);
  });
});
