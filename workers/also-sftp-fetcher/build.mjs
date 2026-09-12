import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DIST = resolve(HERE, "dist");

mkdirSync(DIST, { recursive: true });

const polySrc = readFileSync(
  resolve(ROOT, "node_modules/ssh2/lib/protocol/crypto/poly1305.js"),
  "utf8",
);

const match = polySrc.match(
  /"data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/,
);

if (!match) {
  throw new Error("ALSO SFTP: poly1305.wasm embedded in ssh2 was not found");
}

const wasmPath = resolve(DIST, "poly1305.wasm");
writeFileSync(wasmPath, Buffer.from(match[1], "base64"));

const EXISTING = [
  "net",
  "stream",
  "crypto",
  "events",
  "buffer",
  "path",
  "dns",
  "util",
  "assert",
  "zlib",
  "tls",
  "module",
  "process",
];

const STUBBED = ["fs", "child_process", "os", "http", "https"];

const banner = `
// Precompiled ssh2 Poly1305 WASM for Cloudflare Workers.
import __also_poly1305_wasm from "./poly1305.wasm";

const __also_wasm_instantiate =
  WebAssembly.instantiate.bind(WebAssembly);

WebAssembly.instantiate = async (src, imports) => {
  const mod =
    src instanceof Uint8Array || src instanceof ArrayBuffer
      ? __also_poly1305_wasm
      : src;

  const result = await __also_wasm_instantiate(mod, imports);

  // workerd may return WebAssembly.Instance directly while the
  // Emscripten glue bundled by ssh2 expects { instance, module }.
  if (result instanceof WebAssembly.Instance) {
    return { instance: result, module: mod };
  }

  return result;
};

import * as __also_ns_net from "node:net";
import * as __also_ns_stream from "node:stream";
import * as __also_ns_crypto from "node:crypto";
import * as __also_ns_events from "node:events";
import * as __also_ns_buffer from "node:buffer";
import * as __also_ns_path from "node:path";
import * as __also_ns_dns from "node:dns";
import * as __also_ns_util from "node:util";
import * as __also_ns_assert from "node:assert";
import * as __also_ns_zlib from "node:zlib";
import * as __also_ns_tls from "node:tls";

const __also_pick = (ns) =>
  ns && (typeof ns.default === "object" || typeof ns.default === "function")
    ? ns.default
    : ns;

globalThis.__alsoNodeBuiltins = {
  net: __also_pick(__also_ns_net),
  stream: __also_pick(__also_ns_stream),
  crypto: __also_pick(__also_ns_crypto),
  events: __also_pick(__also_ns_events),
  buffer: __also_pick(__also_ns_buffer),
  path: __also_pick(__also_ns_path),
  dns: __also_pick(__also_ns_dns),
  util: __also_pick(__also_ns_util),
  assert: __also_pick(__also_ns_assert),
  zlib: __also_pick(__also_ns_zlib),
  tls: __also_pick(__also_ns_tls),
};

const __also_unsupported = (name) => () => {
  throw new Error("Unsupported Node builtin in ALSO SFTP Worker: " + name);
};

class __alsoAgent {
  constructor() {
    throw new Error("HTTP proxy agents are not supported in ALSO SFTP Worker");
  }
}

globalThis.__alsoNodeStubs = {
  fs: {
    readFile: __also_unsupported("fs"),
    stat: __also_unsupported("fs"),
    exists: __also_unsupported("fs"),
    readdir: __also_unsupported("fs"),
    readFileSync: __also_unsupported("fs"),
  },
  child_process: {
    execFile: __also_unsupported("child_process"),
    spawn: __also_unsupported("child_process"),
    exec: __also_unsupported("child_process"),
    execFileSync: __also_unsupported("child_process"),
  },
  os: {
    hostname: __also_unsupported("os"),
    tmpdir: __also_unsupported("os"),
    platform: () => "workerd",
  },
  http: {
    Agent: __alsoAgent,
    request: __also_unsupported("http"),
    get: __also_unsupported("http"),
  },
  https: {
    Agent: __alsoAgent,
    request: __also_unsupported("https"),
    get: __also_unsupported("https"),
  },
};
`;

const ALL = new Set([...EXISTING, ...STUBBED]);

const nodeBuiltinsPlugin = {
  name: "also-node-builtins",
  setup(b) {
    const filter = new RegExp(`^(?:node:)?(${[...ALL].join("|")})$`);

    b.onResolve({ filter }, (args) => {
      const name = args.path.replace(/^node:/, "");
      if (!ALL.has(name)) return undefined;
      return { path: name, namespace: "also-builtin" };
    });

    b.onLoad({ filter: /.*/, namespace: "also-builtin" }, (args) => ({
      loader: "js",
      contents:
        `module.exports = globalThis.__alsoNodeBuiltins[${JSON.stringify(args.path)}] ` +
        `?? globalThis.__alsoNodeStubs[${JSON.stringify(args.path)}];`,
    }));
  },
};

await build({
  entryPoints: [resolve(HERE, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  outfile: resolve(DIST, "worker.bundle.mjs"),
  plugins: [nodeBuiltinsPlugin],
  define: {
    __dirname: '"/"',
    __filename: '"/ssh2.js"',
  },
  external: ["cpu-features", "*.node", "*.wasm", "cloudflare:*"],
  banner: { js: banner },
  logLevel: "warning",
});

console.log(
  `ALSO SFTP bundle OK; poly1305.wasm=${readFileSync(wasmPath).byteLength} bytes`,
);
