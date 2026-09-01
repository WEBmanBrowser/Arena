// B.3.2 — Eupago Webhooks 2.0 signature + encryption security tests.
// Pure crypto/verification: no database, no network. Dummy keys only.

import { describe, it, expect } from "vitest";
import {
  assertAesKeyBytes,
  base64ToBytes,
  bytesToBase64,
  computeSignature,
  constantTimeEquals,
  decodeIv,
  extractEncryptedData,
  hmacSha256,
  isEncryptedDelivery,
  verifyEupagoWebhook,
  verifySignature,
} from "./webhook-crypto";
import { ProviderError } from "../errors";

// Dummy, non-production values.
const KEY_32 = "0123456789abcdef0123456789abcdef"; // exactly 32 UTF-8 bytes
const KEY_SHORT = "too-short-key";

const PLAIN_BODY = '{"trid":"T-1","status":"Paid","amount":"12.34","identifier":"MDT-1-aa"}';

function headers(extra: Record<string, string>): Record<string, string> {
  return { "content-type": "application/json", ...extra };
}

async function aesEncrypt(
  key: string,
  plaintext: string,
  iv: Uint8Array<ArrayBuffer>
): Promise<string> {
  const keyBytes = assertAesKeyBytes(key);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
    "encrypt",
  ]);
  const encoded = new TextEncoder().encode(plaintext);
  const buf = new Uint8Array(new ArrayBuffer(encoded.length));
  buf.set(encoded);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, buf);
  return bytesToBase64(new Uint8Array(ciphertext));
}

function randomIv(): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(new ArrayBuffer(16));
  crypto.getRandomValues(iv);
  return iv;
}

async function expectWebhookInvalid(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ code: "WEBHOOK_INVALID" });
}

describe("B.3.2 — HMAC primitives", () => {
  it("produces a padded Base64 signature of a raw 32-byte HMAC (44 chars)", async () => {
    const signature = await computeSignature(KEY_32, PLAIN_BODY);
    expect(signature).toHaveLength(44);
    expect(signature.endsWith("=")).toBe(true);
    expect(base64ToBytes(signature)).toHaveLength(32);
  });

  it("uses the webhook key DIRECTLY as UTF-8 bytes (no derivation/hashing)", async () => {
    // Reference implementation using the key bytes verbatim.
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(KEY_32),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(PLAIN_BODY))
    );
    expect(bytesToBase64(await hmacSha256(KEY_32, PLAIN_BODY))).toBe(bytesToBase64(expected));
  });

  it("compares in constant time and rejects length mismatches", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeEquals(a, new Uint8Array([1, 2, 3, 4]))).toBe(true);
    expect(constantTimeEquals(a, new Uint8Array([1, 2, 3, 5]))).toBe(false);
    expect(constantTimeEquals(a, new Uint8Array([1, 2, 3]))).toBe(false);
    expect(constantTimeEquals(a, new Uint8Array([1, 2, 3, 4, 0]))).toBe(false);
  });

  it("rejects malformed Base64 signatures without throwing", async () => {
    expect(await verifySignature(KEY_32, PLAIN_BODY, "not base64!!")).toBe(false);
    expect(await verifySignature(KEY_32, PLAIN_BODY, "")).toBe(false);
    expect(await verifySignature(KEY_32, PLAIN_BODY, null)).toBe(false);
  });
});

describe("B.3.2 — webhook encrypt=false (raw body HMAC)", () => {
  it("accepts a valid signature computed over the COMPLETE RAW body", async () => {
    const signature = await computeSignature(KEY_32, PLAIN_BODY);
    const result = await verifyEupagoWebhook(KEY_32, PLAIN_BODY, headers({ "x-signature": signature }));
    expect(result.encrypted).toBe(false);
    expect(result.payload.trid).toBe("T-1");
  });

  it("fails when the body is JSON.parse'd and re-stringified (reserialization)", async () => {
    // Whitespace/key-order-sensitive: signing the canonical form must NOT
    // validate a differently formatted raw body.
    const rawWithWhitespace = '{\n  "trid": "T-1",\n  "status": "Paid",\n  "amount": "12.34"\n}';
    const reserialized = JSON.stringify(JSON.parse(rawWithWhitespace));
    expect(reserialized).not.toBe(rawWithWhitespace);

    const signatureOverReserialized = await computeSignature(KEY_32, reserialized);
    await expectWebhookInvalid(
      verifyEupagoWebhook(KEY_32, rawWithWhitespace, headers({ "x-signature": signatureOverReserialized }))
    );

    // The signature over the true raw bytes does validate.
    const signatureOverRaw = await computeSignature(KEY_32, rawWithWhitespace);
    const ok = await verifyEupagoWebhook(
      KEY_32,
      rawWithWhitespace,
      headers({ "x-signature": signatureOverRaw })
    );
    expect(ok.payload.trid).toBe("T-1");
  });

  it("fails closed when X-Signature is missing (no unsigned mode)", async () => {
    await expectWebhookInvalid(verifyEupagoWebhook(KEY_32, PLAIN_BODY, headers({})));
    await expectWebhookInvalid(verifyEupagoWebhook(KEY_32, PLAIN_BODY, headers({ "x-signature": "  " })));
  });

  it("fails when the signature is invalid or made with another key", async () => {
    await expectWebhookInvalid(
      verifyEupagoWebhook(KEY_32, PLAIN_BODY, headers({ "x-signature": bytesToBase64(new Uint8Array(32)) }))
    );
    const wrongKeySignature = await computeSignature("ffffffffffffffffffffffffffffffff", PLAIN_BODY);
    await expectWebhookInvalid(
      verifyEupagoWebhook(KEY_32, PLAIN_BODY, headers({ "x-signature": wrongKeySignature }))
    );
  });

  it("fails when a single body byte is tampered with", async () => {
    const signature = await computeSignature(KEY_32, PLAIN_BODY);
    const tampered = PLAIN_BODY.replace('"12.34"', '"99.34"');
    await expectWebhookInvalid(verifyEupagoWebhook(KEY_32, tampered, headers({ "x-signature": signature })));
  });
});

describe("B.3.2 — webhook encrypt=true (HMAC over the Base64 data string)", () => {
  it("accepts a signature computed over the EXACT Base64 data string value", async () => {
    const iv = randomIv();
    const data = await aesEncrypt(KEY_32, PLAIN_BODY, iv);
    const body = JSON.stringify({ data });
    const signature = await computeSignature(KEY_32, data);

    const result = await verifyEupagoWebhook(
      KEY_32,
      body,
      headers({ "x-signature": signature, "x-initialization-vector": bytesToBase64(iv) })
    );
    expect(result.encrypted).toBe(true);
    expect(result.payload.trid).toBe("T-1");
    expect(result.payload.status).toBe("Paid");
  });

  it("rejects an HMAC computed over the DECODED CIPHERTEXT bytes", async () => {
    const iv = randomIv();
    const data = await aesEncrypt(KEY_32, PLAIN_BODY, iv);
    const body = JSON.stringify({ data });
    const ciphertextAsBinaryString = String.fromCharCode(...base64ToBytes(data));
    const wrongSignature = await computeSignature(KEY_32, ciphertextAsBinaryString);

    await expectWebhookInvalid(
      verifyEupagoWebhook(
        KEY_32,
        body,
        headers({ "x-signature": wrongSignature, "x-initialization-vector": bytesToBase64(iv) })
      )
    );
  });

  it("rejects an HMAC computed over the FULL request body", async () => {
    const iv = randomIv();
    const data = await aesEncrypt(KEY_32, PLAIN_BODY, iv);
    const body = JSON.stringify({ data });
    const wrongSignature = await computeSignature(KEY_32, body);

    await expectWebhookInvalid(
      verifyEupagoWebhook(
        KEY_32,
        body,
        headers({ "x-signature": wrongSignature, "x-initialization-vector": bytesToBase64(iv) })
      )
    );
  });

  it("rejects an HMAC computed over the QUOTED data string or the decrypted JSON", async () => {
    const iv = randomIv();
    const data = await aesEncrypt(KEY_32, PLAIN_BODY, iv);
    const body = JSON.stringify({ data });

    for (const wrongInput of [`"${data}"`, PLAIN_BODY]) {
      const wrongSignature = await computeSignature(KEY_32, wrongInput);
      await expectWebhookInvalid(
        verifyEupagoWebhook(
          KEY_32,
          body,
          headers({ "x-signature": wrongSignature, "x-initialization-vector": bytesToBase64(iv) })
        )
      );
    }
  });

  it("never decrypts before the signature is verified", async () => {
    const iv = randomIv();
    const data = await aesEncrypt(KEY_32, PLAIN_BODY, iv);
    // A bad signature must fail even though the IV is missing/invalid — proof
    // that the failure happens at the signature stage, before any decryption.
    const body = JSON.stringify({ data });
    await expectWebhookInvalid(
      verifyEupagoWebhook(
        KEY_32,
        body,
        headers({ "x-signature": bytesToBase64(new Uint8Array(32)) })
      )
    );

    // With a VALID signature and the same missing IV, the failure moves to the
    // IV/decryption stage — so decryption was only reached after verification.
    const validSignature = await computeSignature(KEY_32, data);
    await expect(
      verifyEupagoWebhook(KEY_32, body, headers({ "x-signature": validSignature }))
    ).rejects.toThrow(ProviderError);
  });

  it("rejects an invalid or wrong-length initialization vector", async () => {
    const iv = randomIv();
    const data = await aesEncrypt(KEY_32, PLAIN_BODY, iv);
    const body = JSON.stringify({ data });
    const signature = await computeSignature(KEY_32, data);

    for (const badIv of [
      bytesToBase64(new Uint8Array(15)),
      bytesToBase64(new Uint8Array(17)),
      "!!!not-base64!!!",
      "",
    ]) {
      await expectWebhookInvalid(
        verifyEupagoWebhook(
          KEY_32,
          body,
          headers({ "x-signature": signature, "x-initialization-vector": badIv })
        )
      );
    }
    expect(() => decodeIv(bytesToBase64(new Uint8Array(16)))).not.toThrow();
  });

  it("fails closed when the webhook key is not exactly 32 UTF-8 bytes", async () => {
    expect(() => assertAesKeyBytes(KEY_SHORT)).toThrow(ProviderError);
    expect(() => assertAesKeyBytes(`${KEY_32}x`)).toThrow(ProviderError);
    // 32 CHARACTERS but 34 BYTES in UTF-8 — must still be rejected.
    expect(() => assertAesKeyBytes("é123456789abcdef0123456789abcdeé")).toThrow(ProviderError);
    expect(assertAesKeyBytes(KEY_32)).toHaveLength(32);
  });

  it("fails closed on invalid padding / undecryptable ciphertext", async () => {
    const iv = randomIv();
    // Random bytes decrypt to garbage padding.
    const bogus = new Uint8Array(new ArrayBuffer(32));
    crypto.getRandomValues(bogus);
    const data = bytesToBase64(bogus);
    const body = JSON.stringify({ data });
    const signature = await computeSignature(KEY_32, data);

    await expectWebhookInvalid(
      verifyEupagoWebhook(
        KEY_32,
        body,
        headers({ "x-signature": signature, "x-initialization-vector": bytesToBase64(iv) })
      )
    );
  });

  it("fails closed when the ciphertext is not an AES block multiple", async () => {
    const iv = randomIv();
    const data = bytesToBase64(new Uint8Array(new ArrayBuffer(20)));
    const body = JSON.stringify({ data });
    const signature = await computeSignature(KEY_32, data);
    await expectWebhookInvalid(
      verifyEupagoWebhook(
        KEY_32,
        body,
        headers({ "x-signature": signature, "x-initialization-vector": bytesToBase64(iv) })
      )
    );
  });
});

describe("B.3.2 — delivery shape detection", () => {
  it("detects encrypted vs plain deliveries", () => {
    expect(isEncryptedDelivery('{"data":"AAAA"}')).toBe(true);
    expect(isEncryptedDelivery(PLAIN_BODY)).toBe(false);
    expect(isEncryptedDelivery("not json")).toBe(false);
  });

  it("extracts the exact data string value", () => {
    expect(extractEncryptedData('{ "data" : "AbC+/123=" }')).toBe("AbC+/123=");
    expect(() => extractEncryptedData("{}")).toThrow(ProviderError);
    expect(() => extractEncryptedData("[]")).toThrow(ProviderError);
  });

  it("rejects an empty body and a missing key", async () => {
    await expectWebhookInvalid(verifyEupagoWebhook(KEY_32, "", headers({ "x-signature": "AA==" })));
    await expectWebhookInvalid(verifyEupagoWebhook("", PLAIN_BODY, headers({ "x-signature": "AA==" })));
  });
});
