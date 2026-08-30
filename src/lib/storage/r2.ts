/**
 * Cloudflare R2 storage provider.
 * Uses the PRODUCT_IMAGES binding from wrangler.jsonc.
 */
import type { StorageProvider } from "./types";

export class R2StorageProvider implements StorageProvider {
  private bucket: R2Bucket;
  private publicUrlBase: string;

  constructor(bucket: R2Bucket, publicUrlBase?: string) {
    this.bucket = bucket;
    this.publicUrlBase = publicUrlBase || "";
  }

  async upload(key: string, data: ArrayBuffer, contentType: string): Promise<void> {
    await this.bucket.put(key, data, { httpMetadata: { contentType } });
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  getPublicUrl(key: string): string | null {
    if (this.publicUrlBase) return `${this.publicUrlBase}/${key}`;
    return null; // No public URL configured — NEVER return storage key as URL
  }
}

/** Try to get R2 bucket from Cloudflare context. Returns null if not available. */
export function getR2Bucket(): R2Bucket | null {
  try {
    const { getCloudflareContext } = require("@opennextjs/cloudflare") as {
      getCloudflareContext: () => { env: Record<string, unknown> };
    };
    const ctx = getCloudflareContext();
    return (ctx?.env?.PRODUCT_IMAGES as R2Bucket) || null;
  } catch {
    return null;
  }
}

// R2Bucket type stub for compilation outside Workers
declare global {
  interface R2Bucket {
    put(key: string, value: ArrayBuffer | ReadableStream | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
    delete(key: string): Promise<void>;
    get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
  }
}
