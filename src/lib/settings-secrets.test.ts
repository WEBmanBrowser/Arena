/**
 * Unit tests for the Backoffice settings-secret encryption primitive.
 *
 * The AES keys used here are generated at runtime with crypto.getRandomValues
 * and exist only in memory for the duration of the test — no secret material
 * is hardcoded in this file.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  SettingsSecretError,
  decryptSettingValue,
  encryptSettingValue,
  isEncryptedSettingValue,
} from "./settings-secrets";

const ENV_NAME = "SETTINGS_ENCRYPTION_KEY";
let savedEnv: string | undefined;

function randomHexKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

beforeEach(() => {
  savedEnv = process.env[ENV_NAME];
  process.env[ENV_NAME] = randomHexKey();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = savedEnv;
});

describe("settings-secrets", () => {
  it("round-trips unicode plaintext through the enc:v1: envelope", async () => {
    const plaintext = "s3cret-çãõ-🔑-value";
    const envelope = await encryptSettingValue(plaintext);
    expect(isEncryptedSettingValue(envelope)).toBe(true);
    expect(envelope.startsWith("enc:v1:")).toBe(true);
    expect(await decryptSettingValue(envelope)).toBe(plaintext);
  });

  it("produces a fresh random IV per encryption (same input, different envelopes)", async () => {
    const a = await encryptSettingValue("same");
    const b = await encryptSettingValue("same");
    expect(a).not.toBe(b);
    expect(await decryptSettingValue(a)).toBe("same");
    expect(await decryptSettingValue(b)).toBe("same");
  });

  it("rejects an empty plaintext", async () => {
    await expect(encryptSettingValue("")).rejects.toMatchObject({ code: "ENCRYPT_FAILED" });
  });

  it("fails closed when the key env var is missing", async () => {
    delete process.env[ENV_NAME];
    await expect(encryptSettingValue("x")).rejects.toMatchObject({
      code: "ENCRYPTION_KEY_MISSING",
    });
    const wellFormedEnvelope = "enc:v1:AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==";
    await expect(decryptSettingValue(wellFormedEnvelope)).rejects.toMatchObject({
      code: "ENCRYPTION_KEY_MISSING",
    });
  });

  it("fails closed when the key env var is malformed", async () => {
    for (const bad of ["short", "zz".repeat(32), "00".repeat(31), "00".repeat(33)]) {
      process.env[ENV_NAME] = bad;
      await expect(encryptSettingValue("x")).rejects.toMatchObject({
        code: "ENCRYPTION_KEY_INVALID",
      });
    }
  });

  it("rejects decrypting a non-envelope value (never treats plaintext as valid)", async () => {
    await expect(decryptSettingValue("plain-secret")).rejects.toMatchObject({
      code: "NOT_ENCRYPTED",
    });
  });

  it("rejects malformed envelopes", async () => {
    for (const bad of ["enc:v1:", "enc:v1:onlyonepart", "enc:v1:a.b.c", "enc:v1:%%%.%%%"]) {
      await expect(decryptSettingValue(bad)).rejects.toBeInstanceOf(SettingsSecretError);
    }
  });

  it("rejects tampered ciphertext (GCM tag mismatch)", async () => {
    const envelope = await encryptSettingValue("integrity");
    const tampered = envelope.slice(0, -2) + (envelope.endsWith("AA") ? "BB" : "AA");
    expect(tampered).not.toBe(envelope);
    await expect(decryptSettingValue(tampered)).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });
  });

  it("rejects decryption with a different key (rotation without re-encrypt fails closed)", async () => {
    const envelope = await encryptSettingValue("rotated?");
    process.env[ENV_NAME] = randomHexKey();
    await expect(decryptSettingValue(envelope)).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });
  });

  it("never includes the key value in error messages", async () => {
    const key = process.env[ENV_NAME]!;
    process.env[ENV_NAME] = "bogus";
    try {
      await encryptSettingValue("x");
      expect.unreachable("must throw");
    } catch (e) {
      expect(String(e)).not.toContain("bogus");
    }
    process.env[ENV_NAME] = key;
    const envelope = await encryptSettingValue("leak?");
    process.env[ENV_NAME] = randomHexKey();
    try {
      await decryptSettingValue(envelope);
      expect.unreachable("must throw");
    } catch (e) {
      expect(String(e)).not.toContain(key);
    }
  });
});
