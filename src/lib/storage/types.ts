/** Storage provider interface for product images */
export interface StorageProvider {
  upload(key: string, data: ArrayBuffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  getPublicUrl(key: string): string | null;
}

export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB

/** JPEG: FF D8 FF, PNG: 89 50 4E 47, WebP: 52 49 46 46 ... 57 45 42 50 */
export function validateImageSignature(data: ArrayBuffer, mimeType: string): boolean {
  const bytes = new Uint8Array(data);
  if (bytes.length < 12) return false;
  if (mimeType === "image/jpeg") return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  if (mimeType === "image/png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  if (mimeType === "image/webp") return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45;
  return false;
}
