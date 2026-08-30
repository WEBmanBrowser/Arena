import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Image optimization: use 'custom' loader for Cloudflare Workers compatibility
  // (Cloudflare does not support Next.js default image optimization out of the box)
  images: {
    unoptimized: true,
  },
  // Required so OpenNext copies the full pg-cloudflare package (including workerd condition files)
  serverExternalPackages: ["pg-cloudflare"],
};

export default nextConfig;
