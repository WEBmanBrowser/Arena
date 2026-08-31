import type { NextConfig } from "next";

/**
 * P1 — Security headers.
 * CSP keeps Next.js/OpenNext hydration working ('unsafe-inline'/'unsafe-eval'
 * for scripts; nonces are a P2 hardening step). frame-ancestors + object-src
 * block clickjacking/plugin abuse; HSTS enforces HTTPS.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];

const nextConfig: NextConfig = {
  // Image optimization: use 'custom' loader for Cloudflare Workers compatibility
  // (Cloudflare does not support Next.js default image optimization out of the box)
  images: {
    unoptimized: true,
  },
  // Required so OpenNext copies the full pg-cloudflare package (including workerd condition files)
  serverExternalPackages: ["pg-cloudflare"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
