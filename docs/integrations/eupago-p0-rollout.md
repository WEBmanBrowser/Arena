# Eupago PAYMENT P0 — integridade financeira: âmbito, rollout e operação

> Checkpoint de **integridade financeira P0**. A ligação do checkout
> (Multibanco / MB WAY / Cartão) é uma fase POSTERIOR: este checkpoint não expõe
> nenhum método novo ao cliente.

## 1. O que este checkpoint garante

| # | Garantia |
|---|---|
| 1 | `payment_attempts.payment_id` — ligação canónica `orders → payments → payment_attempts` (histórico antigo fica `NULL`, sem backfill automático) |
| 2 | `payment_attempts.operation_revision` — fencing contra respostas antigas do fornecedor |
| 3 | `email_notifications.dispatch_started_at` — fencing do outbox pós-commit |
| 4-6 | FKs compostas `(payment_id, order_id) → payments(id, order_id)` em `payment_attempts` e `refund_attempts` (impossível ligar a outra encomenda) |
| 7 | Guards de identidade/snapshot/refund (triggers PostgreSQL) |
| 8 | Migração versionada `0017`, aditiva, sem `DROP`, sem backfill financeiro automático |
| 9 | Confirmação transacional canónica (uma única `payments` liquidada, por encomenda) |
| 10 | Settlement atómico: claim + attempt + payment + order + stock + history + audit + outbox + `processed` na MESMA transação |
| 11 | Nenhuma chamada Eupago/Resend/Wintouch dentro dessa transação |
| 12 | Refunds com claim atómico **antes** do HTTP externo |
| 13 | UNKNOWN mantém o compromisso e **nunca** re-arma automaticamente |
| 14 | Recovery com `found` / `proven_absent` / `unknown` |
| 15 | Nenhum produtor HTTP real de `proven_absent` (só prova injetada) |
| 16 | `operation_revision` / fencing nas escritas pós-resposta |
| 17 | Contexto não secreto `payments.metadata.eupagoEnvironment` |
| 18 | `eupago_ledger_environment` interno e não editável no Backoffice |
| 19 | Histórico de ambiente desconhecido → fail-closed |
| 20 | Email outbox pós-commit (nunca dentro da transação financeira) |
| 21 | Auditoria financeira obrigatória dentro da transação |
| 22 | Confirmação manual compatível e **sem** marcar todos os `payments` da encomenda |
| 23 | Refunds associados ao `payment` canónico e `originalTrid` correto |
| 24 | Reembolsos parciais e proteção de over-refund preservados (trigger B.3.5 intacto) |

## 2. Rollout (B1) — LEDGER EUPAGO VIRGEM

O `0017` ativa guards que pressupõem um ledger **sem** histórico Eupago. Não
existe arquitetura multi-versão neste projeto: o rollout assume um ledger virgem
e para explicitamente se não for o caso.

### Passo 1 — Diagnóstico READ-ONLY (obrigatório, antes de tudo)

```bash
DATABASE_URL=<url da BD alvo> node scripts/eupago-ledger-virgin-check.cjs
```

O script só executa `SELECT`/`COUNT` (recusa qualquer outro verbo), recusa
alvos não-loopback sem `--allow-remote`, e responde com evidência:

- `payment_attempts` com `provider = 'eupago'` → 0
- `refund_attempts` com `provider = 'eupago'` → 0
- `provider_webhook_events` com `provider = 'eupago'` → 0
- `payments` com contexto Eupago (`provider = 'eupago'` ou
  `metadata.eupagoEnvironment`) → 0
- operações em voo (`recovery_state IN ('requested','reconciliation_required')`)
  → 0
- `0017` ainda **não** instalado

**VIRGEM** → avançar. **NÃO VIRGEM** → **STOP**, não instalar `0017`; é
necessário um plano separado de compatibilidade/backfill/cutover.

### Passo 2 — Migração versionada (nunca `db:push`)

```bash
# aplica 0000…0017 em ordem, com registo em drizzle/__drizzle_migrations
npx drizzle-kit migrate      # com DATABASE_URL da BD alvo
```

Regras:
- **`db:push` NUNCA é usado** para instalar `0017` (o `push` não é versionado nem
  auditável e não distingue "criar" de "alterar").
- A migração é **aditiva**: acrescenta colunas, um índice, duas FKs compostas e
  dois triggers. Não remove nada e não reescreve linhas.
- Não há backfill financeiro automático: linhas históricas mantêm
  `payment_id = NULL` e continuam legíveis (a exceção de legacy do trigger só se
  aplica a uma linha que **já era** Eupago e **já estava** sem `payment_id`).

### Passo 3 — Deploy do código novo, com Eupago SEM tráfego

1. Instalar `0017` (passo 2).
2. Deploy do código novo **mantendo a Eupago sem tráfego** (o checkout continua
   apenas com `bank_transfer`; nenhum webhook Eupago configurado no portal).
3. Só depois de validado é que a fase seguinte (checkout) pode abrir tráfego.

### Matriz de compatibilidade (imposta em runtime)

| Estado | Migração `0017` | Código novo | Resultado |
|---|---|---|---|
| A | ausente | ausente | Estado atual — sem alterações |
| B | **instalada** | ausente | Compatível: apenas colunas/índices/FKs/triggers aditivos; o código antigo continua a funcionar, e a exceção de legacy mantém as linhas antigas escrevíveis |
| C | ausente | presente | **Impedido**: `assertEupagoLedgerReady()` falha fechado com `MIGRATION_REQUIRED_0017 missing: …` antes de qualquer escrita financeira |
| D | instalada | presente | Estado alvo |

O caso C está implementado **no código** (não é uma convenção de deploy):
qualquer escrita de pagamento Eupago verifica colunas e triggers antes de
avançar.

## 3. Verificação de virgindade no produto (item 18/19)

`eupago_ledger_environment` é gravado **uma única vez**, na primeira operação
Eupago de um ledger virgem:

- não pertence a `CORE_KEYS`/`AUX_KEYS` do serviço de configuração → o Backoffice
  não o lê nem o escreve;
- `/api/admin/settings` rejeita qualquer chave `eupago_*`;
- um valor gravado que não seja `sandbox|production` → `LEDGER_ENVIRONMENT_UNREADABLE`
  (fail-closed);
- ambiente gravado diferente do ambiente efetivo → `LEDGER_ENVIRONMENT_MISMATCH`;
- histórico Eupago sem contexto de ambiente → `LEDGER_HISTORY_ENVIRONMENT_UNKNOWN`;
- histórico Eupago sem ambiente registado → `LEDGER_ENVIRONMENT_NOT_RECORDED_FOR_EXISTING_HISTORY`
  (exatamente o caso NÃO VIRGEM do B1).

## 4. Outbox de email (M5) — operação sem cron

`email_notifications` passa a ter estados de outbox: `queued` → `dispatching` →
`sent` / `failed` / `delivery_unknown`.

- A linha é escrita **dentro** da transação financeira (dedupe por `event_key`) e
  entregue **depois** do commit.
- `delivery_unknown` (rede/timeout/5xx/429) **não tem retry automático**: o
  email pode já ter chegado ao cliente.
- Leitura: `GET /api/admin/email-outbox` (manager+) devolve contadores e as
  linhas que precisam de atenção, com destinatário **mascarado**.
- Recuperação manual: `POST /api/admin/email-outbox/[id]/requeue` (admin, CSRF,
  auditado, uma linha por pedido).
- **C4 — dispatch preso (crash entre o commit e o envio).** Uma linha que ficou
  `queued` é drenada por `POST /api/admin/email-outbox/dispatch-queued`
  (admin, CSRF, auditado `email_outbox.queued_dispatched`, lote limitado a 1–20
  linhas, por omissão 5; só linhas `queued`, mais antigas primeiro). Uma linha em
  `dispatching` **não** é varrida: a sua claim só é libertada pela decisão
  explícita `POST /api/admin/email-outbox/[id]/requeue?releaseStrandedClaim=1`,
  que só re-arma uma claim **abandonada** (mais antiga que `STRANDED_CLAIM_MS`,
  15 min); uma claim recente é recusada com `CLAIM_STILL_ACTIVE`. Uma requeue
  normal (sem a flag) de uma linha `dispatching` responde `NOT_REQUEUEABLE`.
  `delivery_unknown` continua a exigir decisão humana por linha.
- **Não** existe Cloudflare Cron Trigger para isto neste checkpoint.

## 5. H3 — webhooks que esgotaram o orçamento

Um webhook financeiro autenticado tem orçamento limitado
(`DEFAULT_MAX_WEBHOOK_ATTEMPTS = 5`, no máximo 2 concessões administrativas ⇒ 15
tentativas). Quando o orçamento acaba e o evento não é correlacionável:

- `POST /api/admin/webhook-anomalies/[id]/grant-recovery` (manager+, CSRF,
  auditado `webhook.recovery_budget_granted`) **restaura** uma janela de
  tentativas;
- a ação **não** reenvia nada, **não** chama a Eupago, **não** cria
  pagamentos/tentativas e **não** altera eventos `processed`;
- é exigida uma **nova entrega autenticada** do fornecedor
  (`NEW_AUTHENTICATED_DELIVERY_REQUIRED`): nenhum valor financeiro é fabricado;
- se os metadados confiáveis persistidos bastarem (caso dos reembolsos), a
  resposta encaminha para a recuperação de reembolso existente
  (`USE_REFUND_RECOVERY`).

### 5.1 Anomalias duráveis (C1/C2/C3) e classificação de resolução (C6)

- Um `Paid` autenticado que **não** pode ser liquidado em coerência com o estado
  real nunca termina como `duplicate`/200 silencioso: o evento passa a `anomaly`
  (terminal para os retries) e a resposta 200 leva `{"anomaly":true,...}`.
  Códigos possíveis: `LATE_PAID` (tentativa terminal `expired`/`cancelled`/
  `failed`, incluindo `LATE_PAID:ATTEMPT_*`, ou encomenda não liquidável),
  `DOUBLE_CHARGE`, `PAYMENT_NOT_COHERENT` (movimento diferente no mesmo
  pagamento), `PROVIDER_EVENT_CONFLICT` (o mesmo `trid` reapareceu com payload
  autenticado semanticamente diferente), `AMOUNT_MISMATCH`,
  `CURRENCY_MISMATCH`, `METHOD_MISMATCH`, `METHOD_MISSING`, `IDENTIFIER_MISMATCH`,
  `REFERENCE_MISMATCH`, `ATTEMPT_NOT_FOUND`, `AMOUNT_MISSING`,
  `REFUND_ATTEMPT_NOT_FOUND`, `ORIGINAL_PAYMENT_NOT_FOUND`.
- Nenhuma anomalia reativa a encomenda, mexe em stock, confirma pagamento ou
  emite reembolso automático; o `trid` e os campos do movimento ficam registados.
- Movimentos autenticados sem candidato local (`ATTEMPT_NOT_FOUND`,
  `ORIGINAL_PAYMENT_NOT_FOUND`) ficam registados na auditoria
  (`payment.provider_unattributed_movement`) e visíveis nos contadores de
  operação existentes — nunca em silêncio.
- Fechar uma anomalia exige **classificação explícita** além da nota (3–500
  caracteres): `REFUNDED` (só aceite com reembolso `succeeded` registado),
  `MANUALLY_RECONCILED`, `FALSE_POSITIVE`, `ACCEPTED_EXCEPTION`; ator, data e
  código ficam na linha e na auditoria (`reconciliation.anomaly_resolved`).

## 6. M4 — `bank_transfer`: evidência

Procura de evidência no repositório e no histórico:

- `payments.provider` é escrito **apenas** como `"manual"` pelo código de
  produção (`POST /api/orders`), com `method = "bank_transfer"`;
- `"bank_transfer"` nunca foi persistido como `payments.provider`;
- as ocorrências em teste eram **fixtures artificiais** (incluindo um
  `provider: "bank_transfer"` em `payment-attempts.test.ts`).

Decisão (sem especulação): **não** se adiciona um provider `bank_transfer` ao
registo de providers. A fixture artificial foi corrigida para a forma histórica
real (`provider = "manual"`, `method = "bank_transfer"`), a limitação está
documentada no próprio teste, e ficam regressões que provam que
`bank_transfer` continua a não ser interpretado como Eupago nem aceite como
provider externo.

## 7. Testes e transporte

Todos os testes correm com `npm test` (PostgreSQL 18.4 descartável + migrações
reais) e com transporte Eupago **simulado** (`fetchImpl` injetado):

- `src/test-support/setup.ts` verifica a ligação efetiva
  (`inet_server_port()`/`inet_server_addr()`), impede o Hyperdrive de substituir
  a ligação validada e **falha o teste** perante qualquer tentativa de HTTP real
  (mesmo quando a aplicação converte a exceção num estado UNKNOWN).
- Nenhum pagamento, reembolso ou chamada real é feito a partir da suite.

## 8. Questões de contrato EM ABERTO (não inventar respostas)

As decisões fail-closed abaixo **não** dependem de suposições sobre o
comportamento da Eupago, mas a sua classificação operacional beneficia de
respostas oficiais. Nenhuma destas perguntas está respondida pelo repositório.

1. **Semântica do `trid`** — o `trid` identifica a **transação durante toda a
   vida** (e pode reaparecer com estado/valor diferentes ao longo do tempo) ou
   identifica **uma notificação** (um `trid` por entrega)? A implementação atual
   assume apenas o que é observável localmente: um `trid` já concluído que volte
   com payload autenticado diferente é escalado como `PROVIDER_EVENT_CONFLICT`
   (nunca respondido como `duplicate`).
2. **Transições de estado** — pode uma operação já notificada como
   `Expired` / `Cancel` / `Error` voltar a ser notificada como `Paid` (com o
   mesmo `trid`)? Se sim, com que prazo? Hoje esse caso é tratado como
   `LATE_PAID` (anomalia durável, sem reativação de encomenda, sem stock, sem
   reembolso automático) e nunca como duplicado silencioso.
3. **Política oficial de re-tentativas de webhook** — para HTTP `503`, a Eupago
   reentrega oficialmente? Com que número de tentativas e durante quanto tempo?
   A nossa resposta a um evento adiado é `503` + `Retry-After: 60`; **não** há
   prova documental de que a Eupago respeita `Retry-After`.
4. **`Retry-After`** — a Eupago interpreta/honra o cabeçalho `Retry-After` ou
   reentrega num intervalo próprio? Se reentrega num intervalo próprio, qual?
5. **Códigos re-tentáveis** — que códigos HTTP/condições levam a reentrega e
   quais são considerados definitivos? (Determina se um `503` nosso é mesmo
   reavaliado e se um `200` com anomalia termina definitivamente o ciclo de
   tentativas.)
6. **Ordenação e idempotência** — a Eupago garante entrega em ordem? Garante
   entrega *at-least-once* com o mesmo `provider_event_id`/payload, ou o mesmo
   movimento pode chegar com identificadores de evento diferentes?

Classificação: **RESIDUAL RISK / CONTRACT VALIDATION REQUIRED** — nada aqui
autoriza relaxar o fail-closed; enquanto não houver resposta oficial, um
`Paid` autenticado incoerente continua a produzir anomalia durável + auditoria,
e um evento adiado continua a responder `503`.
