# Arena — Continuidade técnica

> Documento de continuidade técnica do projeto Arena. Regista, de forma
> objetiva e verificável, o estado do repositório, checkpoints concluídos,
> decisões vigentes e regras de segurança/continuidade. Deve ser atualizado a
> cada checkpoint relevante. **Nunca incluir secrets neste documento.**

Última atualização: 2026-09-18

---

## 1. Checkpoint atual

| Ref | SHA | Notas |
|---|---|---|
| Base anterior | `2bf3fa609d5c941347c050ec1f365f0e1ac3b5ce` (`2bf3fa6`) | Merge do PR #40 (`arena/wintouch-cloud-integration`); ponto de partida deste ciclo |
| Checkpoint Eupago | `5c1e6c4ff2cf8809607dab322d76c0eeb0a8e2c1` (`5c1e6c4`) | "Add secure Eupago backoffice configuration"; branch `arena/01a0a6e6-arena`; feito push para `origin` |

Working tree: **clean** no momento deste registo. Sem PR aberto, sem merge, sem deploy do checkpoint Eupago.

> Nota (2026-09-18): o checkpoint PAYMENT P0 descrito na secção 2 está **por commitar**; o working tree tem
> alterações locais não commitadas. Continua **sem PR, sem merge e sem deploy**.

---

## 2. PAYMENT P0 — integridade financeira Eupago (ESTE CHECKPOINT, NÃO COMMITADO)

Trabalho **em curso, não commitado** (branch de trabalho; sem PR, sem merge, sem deploy).
Plano detalhado de rollout: `docs/integrations/eupago-p0-rollout.md`.

- **Migração versionada 0017** (`drizzle/0017_eupago_p0_ledger_integrity.sql`), **aditiva, sem DROP e sem backfill financeiro automático**:
  `payment_attempts.payment_id` (nullable para histórico, obrigatório para tentativas Eupago novas),
  `payment_attempts.operation_revision` e `refund_attempts.operation_revision` (NOT NULL default 0),
  `email_notifications.dispatch_started_at`, índice único `payments_id_order_unique` e FKs compostas
  `(payment_id, order_id) → payments(id, order_id)`, mais dois triggers (`payment_attempts_identity_guard`,
  `refund_attempts_payment_binding_guard`).
- **Nunca `db:push`** para instalar 0017: diagnóstico READ-ONLY obrigatório antes
  (`scripts/eupago-ledger-virgin-check.cjs`; só SELECT, recusa alvos não-loopback). Ledger virgem → 0017 → deploy de código
  com Eupago sem tráfego. Não virgem → **STOP** e plano de compatibilidade/backfill/cutover separado.
  **Esse diagnóstico NÃO foi executado contra nenhuma base real neste checkpoint.**
- **Cadeia canónica** `orders → payments → payment_attempts`: cada tentativa Eupago fica ligada ao `payment` canónico do
  mesmo pedido, com contexto não secreto `payments.metadata.eupagoEnvironment`. A confirmação marca **um único** payment
  canónico (nunca "todos os payments do pedido") e o movimento de reserva é feito com `FOR UPDATE` por ordem crescente de id.
- **Settlement atómico** (claim + tentativa + payment + pedido + stock + histórico + auditoria + outbox + `processed` na MESMA
  transação) e **sem chamadas Eupago/Resend/Wintouch dentro** dessa transação; email entregue só depois do commit.
- **Recuperação**: `found` / `proven_absent` / `unknown`; UNKNOWN mantém o compromisso e nunca re-arma; `proven_absent` só com
  prova positiva injetada (nenhum caminho HTTP real a produz).
- **H1** (parsing): valores decimais exatos ou rejeitados (99.999 nunca é arredondado); método só por label/alias explícito
  (nada de `includes("cc")`; "success" não é cartão); aliases duplicados têm de coincidir.
- **H2/H3**: entregas só com referência ainda não persistida ficam **deferred** e são reavaliadas na reentrega do mesmo `trid`;
  o orçamento automático de processamento mantém-se limitado, com concessão administrativa auditada e de escopo mínimo
  (sem reenvio, sem criar pagamentos, exige nova entrega autenticada).
- **M3**: a suite de testes corre **ligada a PostgreSQL descartável** (verificação por query de `inet_server_port()`), impede
  Hyperdrive e **falha qualquer tentativa de HTTP real** (incluindo as que seriam convertidas em UNKNOWN).
- **M5**: outbox de email com `queued`/`dispatching`/`sent`/`failed`/`delivery_unknown`; `delivery_unknown` **não** tem retry
  automático; recuperação manual auditada por operador. **Sem** Cloudflare Cron Trigger.
- **integração de pagamentos no checkout continua só `bank_transfer`** (intencional): Multibanco/MB WAY/Cartão são fase
  posterior ao P0 financeiro.

---

## 3. Eupago — configuração segura pelo Backoffice (CONCLUÍDO)

Implementação da gestão de credenciais/webhooks Eupago no Backoffice, integrada no commit `5c1e6c4`:

- **Âmbito**: 17 ficheiros — 10 added + 7 modified (ver `git show --stat 5c1e6c4`).
- **Segredos cifrados em repouso** com `SETTINGS_ENCRYPTION_KEY` (64 hex chars / 32 bytes) — AES-256-GCM via Web Crypto, envelope versionado `enc:v1:<iv>.<ciphertext+tag>`, IV aleatório por gravação; a chave vive apenas no ambiente do servidor (`wrangler secret put`), nunca no Git.
- **Bloco de configuração atómico / fail-closed**: os 5 campos nucleares (ambiente, API key, OAuth Client ID, OAuth Client Secret, chave de webhook) formam um único bloco. Backoffice vazio → fallback para env (`EUPAGO_*`, comportamento anterior inalterado). Qualquer valor no Backoffice → os 5 passam a ser obrigatórios; bloco parcial = provider indisponível (nunca se misturam valores Backoffice/ENV). Linhas adulteradas ou chave errada → `BACKOFFICE_UNREADABLE` (fail closed).
- **Permissões**: ver estado (presence-only) = **manager+**; guardar/limpar/testar ligação = **admin**; mutações com CSRF same-origin (`csrfGuard`) e audit log apenas com nomes de campos.
- **Presence-only**: `GET /api/admin/settings/eupago` nunca devolve valores nem fragmentos de segredos; o endpoint genérico `/api/admin/settings` deixou de expor/aceitar chaves `eupago_*` (isolamento testado).
- **Testar ligação**: uma chamada OAuth `client_credentials` side-effect-free com as credenciais efetivas; config incompleta → 400 sem qualquer chamada de rede; token nunca devolvido/persistido.
- **Compatibilidade**: fallback env mantido conforme implementação (`providers/eupago/config.ts` inalterado na lógica de leitura; runtime de pagamento/refund/webhook passa a usar `resolveEupagoConfig()` / `resolveEupagoWebhookKey()`).
- **`webhook-crypto.ts` existente NÃO foi alterado** neste checkpoint (HMAC/AES das notificações permanece intacto).
- Documentação de operação: `docs/integrations/eupago-backoffice.md`.

---

## 4. Validações reproduzidas (checkpoint Eupago)

| Validação | Resultado |
|---|---|
| Patch recuperado vs checkpoint original | **17/17 ficheiros byte-exatos** (blobs idênticos) |
| Lint (`eslint .`, sem `--fix`) | **exit 0** — 0 erros, 9 warnings pré-existentes fora do patch |
| Testes focados (`settings-secrets`, `eupago-config-service`, `eupago-config-routes`, `admin-settings-isolation`) | **4/4 ficheiros PASS, 54/54 testes PASS** (Postgres embutido via `scripts/test-runner.cjs`) |
| `git diff --check` | **clean** (exit 0, sem output) — incluindo os 10 ficheiros added via `--no-index` |

---

## 5. Estado operacional Eupago

- **Sem secrets reais configurados** — nem no repositório nem neste documento. Antes de guardar o primeiro segredo no Backoffice: `wrangler secret put SETTINGS_ENCRYPTION_KEY` (ver doc de operação).
- **Sem pagamento real de teste** — nenhum pagamento/referência real foi criado contra a Eupago neste ciclo.
- **Sem deploy deste checkpoint** — o commit `5c1e6c4` está pushed mas ainda não foi deployado para staging/produção.

---

## 6. Wintouch C.4 — estado e decisão

- **PROBE read-only** já integrado na base (`2bf3fa6`): cliente HTTP + diagnóstico sem escrita (ver `docs/integrations/wintouch-cloud.md`).
- **API key validada através do DB Manager / consulta de enterprises; os endpoints Legacy testados continuam com HTTP 500.**
- **Decisão**: aguardar suporte Wintouch. **Não alterar C.4 entretanto.**

---

## 7. ALSO — separação pricelist / stock

- Manter **rigorosamente separados** `pricelist-1.txt` e `stock.txt` (fontes, parsing, pipelines e efeitos).
- **`pricelist-1.txt`**: gere catálogo e preços; **não** toca em stock físico.
- **`stock.txt`** (stock feed): atualiza **apenas** disponibilidade e `product_suppliers.supplier_stock`; **não cria produtos**; **não altera** preços, categorias nem `products.stock`.

---

## 8. ALSO — próximo trabalho planeado (categorias)

- Preservar `CategoryText1`, `CategoryText2`, `CategoryText3` **separadamente** (não concatenar).
- Implementar hierarquia **`CategoryText1` → `CategoryText2` → `CategoryText3` → Produto**.
- Criação/reutilização **idempotente** de categorias, com **parent correto** em todos os níveis.
- **Slugs globais determinísticos e collision-safe** (estáveis entre runs, sem colisões entre níveis/fornecedores).
- O **stock feed nunca toca em categorias** (regra da secção 6 mantém-se).

---

## 9. Sentinel `1410065407`

- O sentinel `1410065407` **continua por resolver**.
- **Não reinterpretar** o seu significado ou tratamento **sem nova evidência** (dados novos do ALSO/Wintouch ou diagnóstico concreto). Manter o comportamento atual até lá.

---

## 10. Regras de segurança/continuidade

1. **Não colocar secrets no Git** — credenciais/chaves vivem em env/`wrangler secret put`; documentos e código nunca as contêm.
2. **Não misturar alterações ALSO/Eupago/Wintouch no mesmo checkpoint** — um checkpoint, um domínio.
3. **Validar antes de commit/deploy** — lint + testes focados + `git diff --check` no mínimo (padrão usado no checkpoint Eupago).
4. **Não executar apply dos previews ALSO `#1014`/`#1013`** — permanecem bloqueados até decisão explícita em contrário.
