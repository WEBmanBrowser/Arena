# EUPAGO — PAYMENT P0: relatório final (17 secções)

Data: 2026-09-18 · Base: `14fa0f8f5ad4293eac5e4a1917608aa23e218537` (main) ·
Branch de trabalho: `arena/01a0b1f0-arena` · **sem commit, sem push, sem PR, sem merge, sem deploy**

> **ATUALIZAÇÃO — CICLO 2.** A revisão independente deste relatório devolveu **BLOCKED**
> (HIGH-1, HIGH-2, HIGH-3/H2, MEDIUM-1, MEDIUM-2, L1–L6). As correções, os testes novos e a
> validação final estão em `docs/integrations/eupago-p0-cycle2-report.md` (secções A–J) e
> substituem o veredicto abaixo. Este documento mantém-se como registo do ciclo 1.

---

## 1. Ficheiros

**Novos (20 ficheiros: 11 de código/doc/infra + 2 de infraestrutura de teste + 7 de teste)**

| Ficheiro | Papel |
|---|---|
| `drizzle/0017_eupago_p0_ledger_integrity.sql` | migração versionada aditiva do P0 |
| `drizzle/meta/0017_snapshot.json`, `drizzle/meta/_journal.json` (mod.) | registo da migração 0017 |
| `src/lib/stock-locks.ts` | `lockProductsAscending` / `lockProduct` (M1) |
| `src/lib/email-outbox.ts` | outbox pós-commit, `delivery_unknown`, transporte injetável (itens 3/20/M5) |
| `src/lib/services/eupago-ledger-service.ts` | ambiente interno do ledger, gate `MIGRATION_REQUIRED_0017`, provisionamento do payment canónico (itens 18/19/B1) |
| `src/app/api/admin/email-outbox/route.ts` | read model operacional (manager+) |
| `src/app/api/admin/email-outbox/[id]/requeue/route.ts` | recuperação manual de 1 email (admin + CSRF + audit) |
| `src/app/api/admin/webhook-anomalies/[id]/grant-recovery/route.ts` | concessão de orçamento H3 (manager+ + CSRF + audit) |
| `scripts/eupago-ledger-virgin-check.cjs` | diagnóstico READ-ONLY do ledger (B1) |
| `docs/integrations/eupago-p0-rollout.md` | rollout, matriz de compatibilidade, evidência M4, operação M5/H3 |
| `src/test-support/setup.ts`, `src/test-support/fixtures.ts` | guardas M3 (BD + HTTP) e fixtures partilhadas |
| 7 ficheiros de teste | `payments-p0-{ledger,migration-0017,outbox,http-locks-refunds,h2-h3}.test.ts`, `providers/eupago/events-h1.test.ts`, `b32-eupago-h2-h3.test.ts` |
| `docs/integrations/eupago-p0-report.md` | este relatório |

**Modificados (23)** — `src/db/schema.ts`, `src/lib/orders.ts`, `src/lib/refunds.ts`,
`src/lib/providers/payment-attempts.ts`, `src/lib/providers/webhook-events.ts`,
`src/lib/providers/eupago/{events,recovery}.ts`,
`src/lib/services/eupago-{payment,refund,settlement}-service.ts`,
`src/app/api/orders/route.ts`, `scripts/test-runner.cjs`, `vitest.config.ts`,
`docs/ARENA-CONTINUITY.md`, `src/lib/audit.ts` + 5 ficheiros de teste ajustados
(`b32-eupago-lifecycle`, `b32-eupago-webhook-route`, `b352-eupago-recovery`,
`b41-dashboard`, `payment-attempts`, `b35-refunds`, `eupago-payments`).

**Intocados, por imposição**: `src/lib/providers/eupago/webhook-crypto.ts` (HMAC/AES),
`src/lib/csrf.ts`, `src/lib/auth.ts`, config Cloudflare (`wrangler*`), Wintouch, checkout
(apenas ordem de lock).

## 2. Reconstrução EUPAGO-P0

A árvore anterior não existia (irrecuperável): o P0 foi reconstruído a partir do `main` atual
e dos requisitos, não de memória de estado. Pontos implementados:

1. `payment_attempts.payment_id` nullable (histórico) — **obrigatório** para tentativas Eupago novas, imposto por trigger.
2. `operation_revision` NOT NULL default 0 em `payment_attempts` **e** `refund_attempts`.
3. `email_notifications.dispatch_started_at` nullable.
4. Cadeia canónica `orders → payments → payment_attempts` (`prepareEupagoLedgerContext` cria/reutiliza o payment Eupago do pedido).
5. FK composta `payment_attempts(payment_id, order_id) → payments(id, order_id)` (+ índice único alvo).
6. FK composta equivalente em `refund_attempts`.
7. Guards: identidade/snapshot da tentativa, binding do reembolso e transmissão ancorada (`originalTrid`).
8. Migração 0017 **aditiva**, sem `DROP`, sem backfill financeiro automático.
9. Confirmação transacional canónica (`confirmOrderPaymentInTx`) — um único payment liquidado.
10. Settlement atómico: claim + tentativa + payment + pedido + stock + histórico + auditoria + outbox + `processed` na mesma transação.
11. Nenhuma chamada Eupago/Resend/Wintouch dentro dessa transação (dispatch de email pós-commit).
12. Reembolsos: claim atómico `armed → requested` **commitado antes** do HTTP externo.
13. UNKNOWN mantém o compromisso e nunca re-arma automaticamente.
14. Recuperação com resultados `found` / `proven_absent` / `unknown`.
15. Nenhum produtor HTTP real de `proven_absent` (só prova positiva injetada).
16. Fencing por `operation_revision` em tentativas **e** reembolsos (`payment.provider_response_stale`, `refund.provider_response_stale`).
17. `payments.metadata.eupagoEnvironment` (não secreto) como proveniência.
18. `eupago_ledger_environment` interno: fora de `ALL_KEYS`, o endpoint genérico de settings rejeita qualquer chave `eupago_*`.
19. Histórico de ambiente desconhecido/não registado → fail-closed (`LEDGER_HISTORY_ENVIRONMENT_UNKNOWN`, `LEDGER_ENVIRONMENT_NOT_RECORDED_FOR_EXISTING_HISTORY`, `LEDGER_ENVIRONMENT_MISMATCH`, `LEDGER_ENVIRONMENT_UNREADABLE`).
20. Email em outbox: escrita em transação, entrega só depois do commit.
21. Auditoria financeira dentro da transação (`createAuditLogTx`).
22. Confirmação manual compatível e **sem** marcar todos os payments do pedido.
23. Reembolsos ligados ao payment canónico (o `originalTrid` é resolvido por essa ligação) e o guard recusa reembolso de fornecedor contra payment manual.
24. Parciais preservados; over-refund continua bloqueado (guard B.3.5 intacto).

## 3. B1 — rollout em ledger virgem

- `scripts/eupago-ledger-virgin-check.cjs`: **só SELECT** (recusa qualquer outro verbo), recusa alvos
  não-loopback sem `--allow-remote`, conta tentativas/reembolsos/webhooks/payments com contexto Eupago e
  operações em voo; **NÃO foi executado contra nenhuma base real** (apenas `node --check`).
- `docs/integrations/eupago-p0-rollout.md`: ordem obrigatória (diagnóstico → 0017 versionado → deploy com
  Eupago **sem tráfego**), proibição explícita de `db:push`, e matriz de compatibilidade A/B/C/D.
- O estado C (código novo antes da migração) está **imposto em runtime**:
  `assertEupagoLedgerReady()` lança `PROVIDER_UNAVAILABLE` com `MIGRATION_REQUIRED_0017 missing: …` —
  testado em `payments-p0-ledger.test.ts` (falha fechada + restauro por rollback).
- Não virgem → **STOP**: testado (`LEDGER_ENVIRONMENT_NOT_RECORDED_FOR_EXISTING_HISTORY`).

## 4. H1 — parsing hostil

`src/lib/providers/eupago/events.ts`:

- `99.999` **nunca** é arredondado: decimais exatos ou `INVALID_AMOUNT` (números passam por string exata, sem `toFixed`).
- Método só por label/alias **exatos** (tabela fechada, normalização de acentos/separadores);
  `"success"` já **não** é cartão (`includes("cc")` eliminado); label desconhecido → `null` → fail-closed.
- Aliases equivalentes têm de **coincidir**: `originalTrid=A` + `original_trid=B` → `CONFLICTING_ORIGINAL_TRID_ALIASES`;
  idem `trid` e `amount`/`valor`.
- Regressões positivas e negativas: `src/lib/providers/eupago/events-h1.test.ts` (17 testes).
- **Crypto intocado** (`webhook-crypto.ts` sem alterações no `git diff`).

## 5. H2 — não correlação transitória

- Entrega com **só referência** e referência ainda não persistida → `deferred`
  (`DEFERRED_REFERENCE_NOT_YET_PERSISTED`), nunca `ignored` permanente; o claim continua contabilizado.
- Reentrega do **mesmo `trid`** depois de a resposta de criação persistir a referência → confirma
  **exatamente uma vez**; a terceira entrega é `duplicate`.
- Identificador sem tentativa correspondente (divergência definitiva) → `mismatch` fail-closed.
- Testes: `src/lib/payments-p0-h2-h3.test.ts` (corrida determinística dentro da própria chamada HTTP) e
  `src/lib/b32-eupago-h2-h3.test.ts`.
- O webhook nunca cria payment/tentativa e nunca chama o create da Eupago (contador de fetch = 1, só o create).

## 6. H3 — orçamento e recuperação administrativa

- `DEFAULT_MAX_WEBHOOK_ATTEMPTS = 5`, `MAX_RECOVERY_GRANTS = 2`, `effectiveMaxAttempts = base × (1 + grants)`
  (teto efetivo 15).
- `POST /api/admin/webhook-anomalies/[id]/grant-recovery`: manager+, CSRF same-origin, corpo ignorado,
  audit `webhook.recovery_budget_granted`, resposta `NEW_AUTHENTICATED_DELIVERY_REQUIRED`.
  **Não** reenvia nada, **não** chama a Eupago, **não** cria payments/tentativas, **não** altera eventos `processed`,
  **não** fabrica payload (exige nova entrega autenticada).
- Estados recusados: `ALREADY_PROCESSED`, `EVENT_TERMINAL_IGNORED`, `EVENT_IN_PROGRESS`, `BUDGET_NOT_EXHAUSTED`,
  `GRANT_LIMIT_REACHED`, `CONFLICT` (concessão atómica numa única instrução).

## 7. M1–M5

**M1.** `src/lib/stock-locks.ts` centraliza o lock ascendente por id de produto; usado no checkout
(`POST /api/orders`, antes do ciclo de reservas), na libertação de reservas (`orders.ts`) e na confirmação
(stock sob lock, com `reservedBefore/After` lidos sob o lock). Testes: ordem ascendente independente da ordem
de entrada + dois writers concorrentes em ordens opostas sem deadlock. O checkout mantém-se funcionalmente igual
(alteração estritamente de ordem de lock + valores de auditoria sob lock).

**M2.** Trigger `enforce_payment_attempt_identity()`: INSERT Eupago sem `payment_id` → `PAYMENT_ATTEMPT_EUPAGO_PAYMENT_REQUIRED`;
UPDATE que **promove** uma linha não-Eupago com `payment_id NULL` para `provider='eupago'` → recusado;
exceção de legacy restrita a linhas que **já** eram Eupago e **já** tinham `payment_id NULL` (nunca retro-ligadas).
Regressão SQL: `payments-p0-ledger.test.ts` + `payments-p0-migration-0017.test.ts`.

**M3.** `src/test-support/setup.ts` + `scripts/test-runner.cjs`: `ARENA_TEST_GUARD=1` com verificação por
**query** (`current_database()`, `inet_server_port()`, `inet_server_addr()`); Hyperdrive inacessível;
`globalThis.fetch` substituído — **qualquer** tentativa de HTTP real conta e falha o teste que a fez
(inclusive as que a aplicação converteria em UNKNOWN). `EMAIL_API_KEY` é removido no arranque da suite
(nenhum email real). É o MESMO harness para todos os ficheiros; o runtime de produção não foi alterado.

**M4.** Evidência: `payments.provider` só é escrito como `"manual"` (checkout) — `provider="bank_transfer"` nunca
existiu em código de produção, apenas em 1 fixture de teste. Sem providers especulativos: a fixture artificial
foi corrigida para a forma histórica real (`provider='manual'`, `method='bank_transfer'`) e há regressão que prova
que o payment manual não é interpretado como Eupago. Ficheiro adicionalmente corrigido:
`src/lib/providers/payment-attempts.test.ts` dependia de um produto semeado (falhava também na base — ver §13).

**M5.** Outbox com `queued → dispatching → sent|failed|delivery_unknown`; `delivery_unknown` (5xx/429/rede)
**nunca** tem retry automático; `dispatching` não é re-claimável; `GET /api/admin/email-outbox` (manager+)
devolve contadores + linhas com destinatário **mascarado**; `POST …/[id]/requeue` (admin + CSRF + audit,
uma linha por pedido); template indisponível → `TEMPLATE_CONTEXT_UNAVAILABLE` (nunca entrega parcial);
logs sem corpo cru do fornecedor (só `name`/`code` sanitizado). **Sem** Cloudflare Cron Trigger.

## 8. Migração 0017

Aditiva, versionada, sem `DROP`/`TRUNCATE`/`UPDATE` (verificado por grep ao ficheiro): índice único
`payments_id_order_unique`, 4 colunas novas, index `pa_payment_idx`, 2 FKs compostas (MATCH SIMPLE → `payment_id NULL`
histórico não é validado) e 2 triggers. Nunca instalada por `db:push`; gate de runtime obriga a 0017 antes de
qualquer escrita Eupago. **Não aplicada a nenhuma base real** neste checkpoint (a suíte aplica-a apenas na BD descartável).

## 9. Teste de migração 0000→0017

`src/lib/payments-p0-migration-0017.test.ts` (9 testes): cria uma **base descartável** no PostgreSQL do runner,
aplica os **ficheiros reais** 0000→0016 (nunca `CREATE TABLE AS SELECT`), insere histórico sintético válido
(incluindo uma tentativa Eupago antiga **sem** `payment_id`), aplica 0017 e verifica: colunas e defaults,
índice/FKs/triggers, preservação integral do histórico (sem backfill), exceção de legacy, snapshot mismatch,
FK cruzada entre pedidos e recusa de transmissão sem `originalTrid`. A base é destruída no fim.

## 10. Invariantes financeiros (com prova)

| Invariante | Onde é imposto | Prova |
|---|---|---|
| Uma tentativa Eupago tem payment canónico do mesmo pedido | trigger + serviço | ledger test |
| Snapshot tentativa↔payment (pedido, cêntimos, moeda) | trigger | ledger test |
| Confirmação liquida **um** payment | `confirmOrderPaymentInTx` | outbox test (2 payments, só 1 paga) |
| Claim + efeitos + `processed` na mesma transação | settlement | h2-h3 + ledger tests |
| Sem HTTP dentro da transação | settlement/outbox | counter de fetch inalterado |
| Claim de reembolso antes do HTTP | refund service | teste que lê `recovery_state='requested'` de outra ligação durante a chamada |
| Resposta atrasada nunca desfaz estado mais novo | `operation_revision` + CAS | http-locks-refunds (tentativa e reembolso) |
| UNKNOWN não re-arma | recovery | prova ausente → `unknown`; `proven_absent` só injetado |
| Budget limitado | `claimWebhookEvent` | h2-h3 (esgotar → `CLAIM_BUDGET_EXHAUSTED`) |
| `delivery_unknown` sem retry | outbox | outbox test (sweep = 0 tentativas) |

## 11. Resultados de testes

- Ficheiros novos: **7 ficheiros, 77 testes, 100% verdes**.
- Suíte completa: **103 ficheiros — 101 verdes, 1 falha, 1 skipped**;
  **1774 testes — 1772 verdes, 1 falha, 1 skipped**.
- A única falha é `src/lib/c344-ssh2-e2e.test.ts > "enforces the stream limit when STAT lies"`
  (`SFTP_TIMEOUT` em vez de `SFTP_TOO_LARGE`, domínio importação/SSH). **É pré-existente e não relacionada**:
  reproduzida de forma idêntica com a árvore de trabalho colocada em stash (base 14fa0f8 inalterada).

## 12. Typecheck / lint / `git diff --check`

- `npx tsc --noEmit` → **0 erros**.
- `npm run lint` → **0 erros**, 6 warnings pré-existentes (imagens `<img>`, `exhaustive-deps`, um `eslint-disable`
  inútil em `src/db/index.ts` nunca tocado).
- `git diff --check` → **sem** erros de whitespace.

## 13. Riscos residuais

| Risco | Nível | Nota |
|---|---|---|
| Ledger virgem em produção com `EUPAGO_ENVIRONMENT` não definido grava `sandbox` | médio | O B1 exige o diagnóstico READ-ONLY e a definição explícita do ambiente antes do cutover; uma divergência posterior falha fechada (não silenciosa) |
| Helpers auxiliares `isRetryable`/`listRetryableWebhookEvents` continuam a usar o orçamento base | baixo | Não são usados pelo caminho `deferred` (que usa `effectiveMaxAttempts`); documentado |
| Transições operacionais de reembolso (B.3.5) não incrementam `operation_revision` | baixo | O fencing do provider usa a revisão do claim; o operador é fenced por estado |
| Teste de legacy usa `session_replication_role = replica` (requer superuser) | baixo | Válido no PostgreSQL descartável do runner |
| `c344-ssh2-e2e` falha na base | informativo | Externo ao checkpoint (importação/SSH) |
| Diagnóstico B1 nunca executado | informativo | Por imposição explícita (nada corre contra a BD real) |

Nenhum **BLOCKER** nem **HIGH** novo foi encontrado na revisão READ-ONLY final.

## 14. Git status

Working tree com alterações locais **não commitadas** na branch `arena/01a0b1f0-arena`:
**23 ficheiros modificados + 20 ficheiros novos** (11 código/doc/infra + 2 test-support + 7 testes).
Sem commit, sem push, sem PR, sem merge, sem deploy. Nenhuma migração aplicada a base real.

## 15. Confirmação de zero efeitos colaterais

- **Nenhuma** chamada real a Eupago/Resend/qualquer serviço (a suíte proíbe e conta; o runtime não foi tocado).
- **Nenhuma** alteração a base de dados real; o diagnóstico B1 não foi executado.
- **Nenhum** segredo alterado, lido ou registado; nenhum secret novo em Git.
- **Nenhuma** configuração Cloudflare, DNS, cron ou deploy alterada.

## 16. Confirmação: checkout inalterado

`POST /api/orders` continua a criar o payment `manual`/`bank_transfer` e a aceitar exatamente os mesmos métodos;
a alteração limita-se ao lock ascendente de produtos (M1) e a ler `reservedBefore/After` da linha bloqueada.
Multibanco/MB WAY/Cartão **não** estão expostos ao cliente (fase posterior, por decisão).

## 17. Confirmação de âmbito + veredicto

Ficou **fora** deste checkpoint (por decisão/instrução): ligação do checkout à Eupago, qualquer alteração ao
Wintouch, qualquer alteração a HMAC/AES/webhook-crypto, cron Cloudflare, alterações a preços/stock da importação
ALSO (checkpoint seguinte, separado), `db:push` e qualquer backfill financeiro automático.

**VEREDITO: READY FOR FINAL REVIEW**
