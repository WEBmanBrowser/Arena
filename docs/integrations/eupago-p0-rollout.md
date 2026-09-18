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
