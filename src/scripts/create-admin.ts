/**
 * B.5.1 — First-administrator bootstrap CLI.
 *
 *   npm run admin:create -- --email admin@example.com --password 'StrongPassword!123'
 *
 * CLI-only. No HTTP endpoint, no .env writing, no bootstrap table, no schema
 * change. The role is hardcoded to "admin" and cannot be chosen by the caller.
 *
 * Logging policy: never print the plaintext password, the bcrypt hash, or any
 * secret (DATABASE_URL / JWT_SECRET / CRON_SECRET / provider secrets).
 */
import "dotenv/config";
import { AdminBootstrapError, createFirstAdmin } from "../lib/admin-bootstrap";

export interface ParsedArgs {
  email?: string;
  password?: string;
  name?: string;
}

const USAGE = `Usage: npm run admin:create -- --email <email> --password <password> [--name "Full Name"]`;

/** Strict flag parser. Unknown flags (including any role flag) are rejected. */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let key: string;
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else if (arg.startsWith("--")) {
      key = arg.slice(2);
      value = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`Unexpected argument: ${arg}\n${USAGE}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}\n${USAGE}`);
    }
    switch (key) {
      case "email":
        out.email = value;
        break;
      case "password":
        out.password = value;
        break;
      case "name":
        out.name = value;
        break;
      default:
        // Explicitly refuse --role and anything else: the role is fixed.
        throw new Error(`Unsupported option: --${key}\n${USAGE}`);
    }
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  if (!args.email) {
    console.error(`--email is required\n${USAGE}`);
    return 2;
  }
  if (!args.password) {
    console.error(`--password is required\n${USAGE}`);
    return 2;
  }

  try {
    const admin = await createFirstAdmin({ email: args.email, password: args.password, name: args.name });
    console.log(`Administrator created: id=${admin.id} email=${admin.email} role=${admin.role}`);
    return 0;
  } catch (e) {
    if (e instanceof AdminBootstrapError) {
      console.error(`Refused (${e.code}): ${e.message}`);
      return 1;
    }
    console.error("Failed to create administrator (see database/server logs).");
    return 1;
  }
}

// Only auto-run when executed directly by the CLI (tsx), never on import.
const invokedDirectly = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("src/scripts/create-admin.ts");
if (invokedDirectly && process.env.ADMIN_CREATE_CLI_NO_RUN !== "1") {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}
