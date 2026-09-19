/**
 * Regression tests for Eupago backoffice "primeiro save sem storedEnvironment".
 *
 * Requirements:
 *  1. If `storedEnvironment === null`, the form visually defaults to "sandbox".
 *  2. On the FIRST save that touches ANY core field (e.g. apiKey, oauthClientId,
 *     oauthClientSecret, webhookKey):
 *     - If the user did NOT change the dropdown (env === null), the payload MUST
 *       explicitly include `environment: "sandbox"`.
 *     - If the user selected "production", the payload sends `environment: "production"`.
 *     - If the user explicitly selected "sandbox", it sends `environment: "sandbox"`.
 *  3. Once `storedEnvironment` exists:
 *     - A metadata-only save MUST NOT send `environment` unnecessarily.
 *     - A core secret update without changing the dropdown does not re-send `environment`.
 *     - Switching environment sends the new environment.
 *     - Selecting the same environment as stored does not send `environment`.
 *  4. Pure client-safe logic without silent server fallbacks.
 */

import { describe, expect, it } from "vitest";
import {
  buildSavePayload,
  isFormDirty,
  hasCoreFieldChanges,
} from "@/app/admin/settings/eupago/save-payload";

describe("Eupago Backoffice — primeiro save sem storedEnvironment (regressão)", () => {
  describe("Primeiro save (storedEnvironment === null) com campos CORE", () => {
    it("inclui explicitamente environment: 'sandbox' ao guardar apiKey com dropdown intacto (env === null)", () => {
      const payload = buildSavePayload({
        secrets: { apiKey: "chave_api_teste_123" },
        env: null,
        storedEnvironment: null,
      });

      expect(payload).toEqual({
        apiKey: "chave_api_teste_123",
        environment: "sandbox",
      });
    });

    it("inclui explicitamente environment: 'sandbox' ao guardar oauthClientId com dropdown intacto", () => {
      const payload = buildSavePayload({
        secrets: { oauthClientId: "client_id_456" },
        env: null,
        storedEnvironment: null,
      });

      expect(payload).toEqual({
        oauthClientId: "client_id_456",
        environment: "sandbox",
      });
    });

    it("inclui explicitamente environment: 'sandbox' ao guardar oauthClientSecret com dropdown intacto", () => {
      const payload = buildSavePayload({
        secrets: { oauthClientSecret: "client_secret_789" },
        env: null,
        storedEnvironment: null,
      });

      expect(payload).toEqual({
        oauthClientSecret: "client_secret_789",
        environment: "sandbox",
      });
    });

    it("inclui explicitamente environment: 'sandbox' ao guardar webhookKey com dropdown intacto", () => {
      const payload = buildSavePayload({
        secrets: { webhookKey: "webhook_key_abc" },
        env: null,
        storedEnvironment: null,
      });

      expect(payload).toEqual({
        webhookKey: "webhook_key_abc",
        environment: "sandbox",
      });
    });

    it("inclui explicitamente environment: 'sandbox' ao guardar os 4 segredos CORE em simultâneo", () => {
      const payload = buildSavePayload({
        secrets: {
          apiKey: "k1",
          oauthClientId: "c1",
          oauthClientSecret: "s1",
          webhookKey: "w1",
        },
        env: null,
        storedEnvironment: null,
      });

      expect(payload).toEqual({
        apiKey: "k1",
        oauthClientId: "c1",
        oauthClientSecret: "s1",
        webhookKey: "w1",
        environment: "sandbox",
      });
    });

    it("envia environment: 'production' quando o utilizador seleciona produção no primeiro save com segredos", () => {
      const payload = buildSavePayload({
        secrets: { apiKey: "k1" },
        env: "production",
        storedEnvironment: null,
      });

      expect(payload).toEqual({
        apiKey: "k1",
        environment: "production",
      });
    });

    it("envia environment: 'production' no primeiro save mesmo sem segredos se o utilizador selecionou produção", () => {
      const payload = buildSavePayload({
        secrets: {},
        env: "production",
        storedEnvironment: null,
      });

      expect(payload).toEqual({
        environment: "production",
      });
    });

    it("envia environment: 'sandbox' quando o utilizador explicitamente seleciona sandbox (env === 'sandbox')", () => {
      const payload = buildSavePayload({
        secrets: { apiKey: "k1" },
        env: "sandbox",
        storedEnvironment: null,
      });

      expect(payload).toEqual({
        apiKey: "k1",
        environment: "sandbox",
      });
    });

    it("não envia payload nem environment se nada foi preenchido nem alterado", () => {
      const payload = buildSavePayload({
        secrets: {},
        env: null,
        storedEnvironment: null,
      });

      expect(payload).toEqual({});
    });
  });

  describe("Primeiro save (storedEnvironment === null) — apenas metadata de webhook", () => {
    it("não inclui environment quando guarda apenas webhookEndpoint no primeiro save", () => {
      const payload = buildSavePayload({
        secrets: {},
        env: null,
        endpoint: "https://example.com/api/webhooks/eupago",
        storedEnvironment: null,
        storedEndpoint: "",
      });

      expect(payload).toEqual({
        webhookEndpoint: "https://example.com/api/webhooks/eupago",
      });
      expect(payload).not.toHaveProperty("environment");
    });

    it("não inclui environment quando guarda apenas webhookEncryption no primeiro save", () => {
      const payload = buildSavePayload({
        secrets: {},
        env: null,
        encryption: true,
        storedEnvironment: null,
        storedEncryption: false,
      });

      expect(payload).toEqual({
        webhookEncryption: true,
      });
      expect(payload).not.toHaveProperty("environment");
    });

    it("não inclui environment quando guarda apenas webhookTypes no primeiro save", () => {
      const payload = buildSavePayload({
        secrets: {},
        env: null,
        types: ["pagamento", "reembolso"],
        storedEnvironment: null,
        storedTypes: [],
      });

      expect(payload).toEqual({
        webhookTypes: ["pagamento", "reembolso"],
      });
      expect(payload).not.toHaveProperty("environment");
    });

    it("não inclui environment quando guarda múltiplos campos de metadata no primeiro save sem campos core", () => {
      const payload = buildSavePayload({
        secrets: {},
        env: null,
        endpoint: "https://example.com/api/webhooks/eupago",
        encryption: true,
        types: ["pagamento"],
        storedEnvironment: null,
        storedEndpoint: "",
        storedEncryption: false,
        storedTypes: [],
      });

      expect(payload).toEqual({
        webhookEndpoint: "https://example.com/api/webhooks/eupago",
        webhookEncryption: true,
        webhookTypes: ["pagamento"],
      });
      expect(payload).not.toHaveProperty("environment");
    });
  });

  describe("Saves subsequentes (storedEnvironment já configurado)", () => {
    it("não envia environment quando guarda apenas metadata com storedEnvironment 'sandbox'", () => {
      const payload = buildSavePayload({
        secrets: {},
        env: null,
        endpoint: "https://novo.endpoint/webhook",
        storedEnvironment: "sandbox",
        storedEndpoint: "https://antigo.endpoint/webhook",
      });

      expect(payload).toEqual({
        webhookEndpoint: "https://novo.endpoint/webhook",
      });
      expect(payload).not.toHaveProperty("environment");
    });

    it("não envia environment quando guarda apenas metadata com storedEnvironment 'production'", () => {
      const payload = buildSavePayload({
        secrets: {},
        env: null,
        encryption: true,
        storedEnvironment: "production",
        storedEncryption: false,
      });

      expect(payload).toEqual({
        webhookEncryption: true,
      });
      expect(payload).not.toHaveProperty("environment");
    });

    it("não re-envia environment ao atualizar um segredo CORE com storedEnvironment já definido e env null", () => {
      const payload = buildSavePayload({
        secrets: { apiKey: "nova_api_key_rotacionada" },
        env: null,
        storedEnvironment: "sandbox",
      });

      expect(payload).toEqual({
        apiKey: "nova_api_key_rotacionada",
      });
      expect(payload).not.toHaveProperty("environment");
    });

    it("envia environment: 'production' ao alternar de 'sandbox' para 'production'", () => {
      const payload = buildSavePayload({
        secrets: {},
        env: "production",
        storedEnvironment: "sandbox",
      });

      expect(payload).toEqual({
        environment: "production",
      });
    });

    it("envia environment: 'sandbox' ao alternar de 'production' para 'sandbox'", () => {
      const payload = buildSavePayload({
        secrets: {},
        env: "sandbox",
        storedEnvironment: "production",
      });

      expect(payload).toEqual({
        environment: "sandbox",
      });
    });

    it("não envia environment quando env é igual ao storedEnvironment existente", () => {
      const payload = buildSavePayload({
        secrets: { apiKey: "k2" },
        env: "sandbox",
        storedEnvironment: "sandbox",
      });

      expect(payload).toEqual({
        apiKey: "k2",
      });
      expect(payload).not.toHaveProperty("environment");
    });
  });

  describe("Filtros de payload, dirty state e helpers auxiliares", () => {
    it("filtra segredos com string vazia deixados no formulário para não sobrescrever", () => {
      const payload = buildSavePayload({
        secrets: {
          apiKey: "nova_chave",
          oauthClientId: "",
          oauthClientSecret: "",
          webhookKey: "",
        },
        env: null,
        storedEnvironment: "sandbox",
      });

      expect(payload).toEqual({
        apiKey: "nova_chave",
      });
    });

    it("calcula isFormDirty corretamente (false quando limpo, true quando com alterações)", () => {
      const clean = isFormDirty({
        secrets: { apiKey: "", oauthClientId: "" },
        env: null,
        endpoint: "https://example.com/api/webhooks/eupago",
        encryption: true,
        types: ["pagamento"],
        storedEnvironment: "sandbox",
        storedEndpoint: "https://example.com/api/webhooks/eupago",
        storedEncryption: true,
        storedTypes: ["pagamento"],
      });
      expect(clean).toBe(false);

      const dirty = isFormDirty({
        secrets: { apiKey: "chave_digitada" },
        env: null,
        storedEnvironment: null,
      });
      expect(dirty).toBe(true);
      expect(hasCoreFieldChanges({ apiKey: "chave_digitada" }, null, null)).toBe(true);
    });

    it("preserva segredo CORE constituído apenas por espaços e ativa first-save sandbox sem suprimir o campo", () => {
      const payload = buildSavePayload({
        secrets: { apiKey: "   " },
        env: null,
        storedEnvironment: null,
      });

      expect(payload).toEqual({
        apiKey: "   ",
        environment: "sandbox",
      });
      expect(hasCoreFieldChanges({ apiKey: "   " }, null, null)).toBe(true);
      expect(isFormDirty({ secrets: { apiKey: "   " }, storedEnvironment: null })).toBe(true);
    });
  });
});
