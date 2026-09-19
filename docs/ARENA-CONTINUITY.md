# Arena — Continuidade técnica

> Documento de continuidade técnica do projeto Arena. Regista, de forma
> objetiva e verificável, o estado do repositório, checkpoints concluídos,
> decisões vigentes e regras de segurança/continuidade. Deve ser atualizado a
> cada checkpoint relevante. **Nunca incluir secrets neste documento.**

Última atualização: 2026-09-19

---

## 1. Checkpoint atual

| Ref | SHA | Notas |
|---|---|---|
| Base anterior | `2bf3fa609d5c941347c050ec1f365f0e1ac3b5ce` (`2bf3fa6`) | Merge do PR #40 (`arena/wintouch-cloud-integration`); ponto de partida do ciclo Eupago backoffice |
| Checkpoint Eupago | `5c1e6c4ff2cf8809607dab322d76c0eeb0a8e2c1` (`5c1e6c4`) | "Add secure Eupago backoffice configuration"; branch `arena/01a0a6e6-arena`; feito push para `origin` |
| `main` (base do PAYMENT P0) | `14fa0f8f5ad4293eac5e4a1917608aa23e218537` (`14fa0f8`) | Merge do PR #44; **parent direto** do checkpoint PAYMENT/Eupago P0 |
| Baseline lógica Cycle 3 | `97849168043fb5c81678b6f5a303876513822e68` (`9784916`) | branch remota `arena/eupago-p0-cycle3-review`; linhagem **distinta** de `main` (merge-base `14fa0f8`); serve apenas de baseline para comparação tree-a-tree |
| **Checkpoint PAYMENT/Eupago P0 (Cycles 1–4)** | **`478e1e0efef5a15dbc6a48ed02b31782a8411d5e`** (`478e1e0`) | "Checkpoint Eupago P0 cycle 4 fixes"; branch remota **`arena/01a0b60b-arena`**; **commitado e pushed para `origin`**; 58 ficheiros (30 added + 28 modified, **0 eliminados**), +19248/−390 |

Working tree: **clean** no momento do registo do checkpoint Eupago backoffice (`5c1e6c4`). Sem PR aberto, sem merge, sem deploy desse checkpoint.

O checkpoint PAYMENT/Eupago P0 descrito na secção 2 está **preservado no commit `478e1e0e`**, na branch remota
**`arena/01a0b60b-arena`** (`origin/arena/01a0b60b-arena` = `478e1e0e`, confirmado por `git ls-remote`). A relação com
`origin/main` é **estritamente linear**: `merge-base(main, 478e1e0e) = 14fa0f8 = tip de main`, **1 commit ahead, 0 behind**,
sem divergência. Continua **sem PR aberto, sem merge para `main` e sem deploy**.

> Nota (2026-09-19): esta revisão **corrige** as afirmações anteriores de "por commitar" / "NÃO COMMITADO" / "em curso, não
> commitado", que deixaram de ser verdadeiras quando o checkpoint foi commitado e pushed. O working tree da sessão é
> **byte-idêntico** ao tree de `478e1e0e` (396/396 ficheiros verificados por `git hash-object`). O HEAD **local** da sessão
> aponta para `14fa0f8` — o conteúdo do checkpoint vive na branch remota, não no HEAD local; face a esse HEAD local
> registam-se 58 entradas alteradas (28 tracked + 30 novas), que correspondem exatamente ao conteúdo de `478e1e0e`.

---

## 2. PAYMENT P0 — integridade financeira Eupago (Cycles 1–4, COMMITADO em `478e1e0e`)

Trabalho **commitado e pushed** no commit `478e1e0efef5a15dbc6a48ed02b31782a8411d5e`, branch remota
`arena/01a0b60b-arena`. **PR #45 aberto, sem merge para `main` e sem promoção do código para o runtime ativo**; a migration 0017 foi **aplicada exclusivamente em Neon STAGING em 2026-09-19** e validada pelo POST-CHECK e pelo delta PRE → POST (ver 2.7).
Plano detalhado de rollout: `docs/integrations/eupago-p0-rollout.md`.

Índice desta secção: **2.1** base P0 (Cycle 1) + Cycle 2 · **2.2** Cycle 3 · **2.3** Cycle 4 · **2.4** revisão
independente · **2.5** residuais P1 · **2.6** questões contratuais abertas · **2.7** estado de rollout.

### 2.1 Base P0 (Cycle 1) e Cycle 2 — invariantes registados

- **Migração versionada 0017** (`drizzle/0017_eupago_p0_ledger_integrity.sql`), **aditiva, sem DROP e sem backfill financeiro automático**:
  `payment_attempts.payment_id` (nullable para histórico, obrigatório para tentativas Eupago novas),
  `payment_attempts.operation_revision` e `refund_attempts.operation_revision` (NOT NULL default 0),
  `email_notifications.dispatch_started_at`, índice único `payments_id_order_unique` e FKs compostas
  `(payment_id, order_id) → payments(id, order_id)`, mais dois triggers (`payment_attempts_identity_guard`,
  `refund_attempts_payment_binding_guard`).
- **Nunca `db:push`** para instalar 0017: diagnóstico READ-ONLY obrigatório antes
  (`scripts/eupago-ledger-virgin-check.cjs`; só SELECT, recusa alvos não-loopback). Ledger virgem → 0017 → deploy de código
  com Eupago sem tráfego. Não virgem → **STOP** e plano de compatibilidade/backfill/cutover separado.
  **Estado posterior (2026-09-19):** o diagnóstico foi executado em **Neon STAGING** e devolveu `VIRGIN`; a 0017 foi depois aplicada e validada nesse ambiente (ver 2.7).
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

### 2.2 Cycle 3 — divergência de payload e evidência durável

- **Gate C2 (pré-transação)**: antes de responder `duplicate` a uma reentrega do mesmo `trid`, o payload recebido é
  comparado **semanticamente** com o estado CURRENT da row do evento; uma divergência material nunca é reconhecida como
  duplicado silencioso. Eventos `ignored` ficam excluídos da comparação (por desenho documentado).
- **`PROVIDER_EVENT_CONFLICT`** e escalada via `escalateConcludedConflict` / `escalateWebhookEventConflict`: a evidência da
  divergência fica **durável** (anomalia + auditoria + `metadata.eventConflict` = fingerprint do conflito). A escalada abre
  a **sua própria** transação (nunca aninhada na de settlement) e é **idempotente por fingerprint** (`IS DISTINCT FROM`),
  pelo que gémeos concorrentes não duplicam a anomalia nem a auditoria. A escalada **não liquida nada** (`settled: false`).
- **Limite de ocorrências**: `recordSettlementAnomalyTx` deduplica por `occurrenceReference` (`onConflictDoNothing`) e está
  limitado a `MAX_ANOMALY_OCCURRENCES = 5` por movimento (referências `trid`, `trid#2` … `trid#5`); esgotado o limite, o
  código continua a ser registado no evento + auditoria (nada fica invisível).
- Testes: `src/lib/payments-p0-cycle3-c1.test.ts`, `payments-p0-cycle3-c2-c3.test.ts`, `payments-p0-cycle3-admin.test.ts`.

### 2.3 Cycle 4 — F-1 (TOCTOU no C8), aceitação por concorrência real, F-3 e F1b

**F-1 / C8 — TOCTOU após perda concorrente do claim.** O gate C2 avaliava um snapshot lido **fora** da transação; quando
esse snapshot ainda dizia `pending`/`failed`, o gate era saltado — mas a entrega que ganhou o claim podia ter **concluído** o
evento enquanto esta esperava pelo lock da row. Responder apenas com base no STATUS relido reconheceria como `duplicate`
simples um payload autenticado que diverge materialmente daquele que foi concluído: exatamente a mudança silenciosa de
significado que o C2 existe para impedir, alcançada pela janela do C8 em vez do caminho de reentrega.

Correção em `src/lib/services/eupago-settlement-service.ts`, **estritamente aditiva** (+77/−0): dentro de `if (!claimed)` e
**antes** de `processed → duplicate`, o estado CURRENT relido (`getWebhookEvent(id, tx)`) é **novamente comparado
semanticamente** com o payload recebido, para `processed` ou anomalia (`ignored` continua excluído, tal como no gate
pré-transação). Havendo divergência:

- fingerprint **diferente** do já registado → devolve `outcome: "payment_anomaly"` / `PROVIDER_EVENT_CONFLICT` **de dentro
  da própria transação** (placeholder fail-closed: mesmo que a escalada pós-commit não chegue a correr, o caller nunca vê
  `duplicate`) e entrega a evidência num marcador interno `conflictEscalation`;
- fingerprint **já registado** → responde com a anomalia que existe (`anomalyCodeOf(current)`), nunca um duplicado simples
  nem uma segunda row de anomalia;
- a escalada corre **pós-commit** (o mesmo padrão já usado no dispatch do outbox), porque `escalateConcludedConflict` abre a
  sua própria transação. **Nada é liquidado**: o claim falhou, logo nenhum payment, stock ou estado de encomenda mudou.

**Aceitação F-1 — 8 testes reais de concorrência** (`src/lib/payments-p0-cycle4-f1-concurrency.test.ts`): pipeline de
produção real contra **PostgreSQL descartável** (nada substituído por mocks), com barreira `SELECT … FOR UPDATE` **na row do
evento** (não na do attempt) e deteção da corrida por **`pg_locks`** (backend com lock `tuple`/`transactionid` não concedido
que detém lock de relação em `provider_webhook_events`), o que força duas entregas autênticas a colidir no claim. O cenário
de payload **idêntico** devolve `CONSUMED_BY_CONCURRENT_DELIVERY`, código que existe **uma única vez** em todo o código de
produção (`eupago-settlement-service.ts:421`, dentro do C8) — é o **discriminador** que prova que o caminho C8 foi realmente
atravessado e que a corrida não degenerou em falso positivo. Complementado por `payments-p0-cycle4-f1.test.ts` (5 testes com
mocks explicitamente anotados como tal) e por `payments-p0-cycle4-f3.test.ts` (8 testes).

**F-3 — classificação `REFUNDED`** (`src/lib/reconciliation.ts`): passa a exigir evidência de refunds `succeeded` do
**mesmo `paymentId`**, na **mesma moeda**, com **cobertura suficiente de `observedPaidCents`** (soma dos `succeeded`).
Múltiplos refunds parciais só contam se `succeeded`; um refund de **outro** payment nunca conta; **não há fallback por
`orderId`**. Falham **fechados**: `paymentId = NULL`, `observedPaidCents` nulo/NaN/não-inteiro/≤ 0 e moeda indeterminada.
A resolução administrativa corre em transação com `SELECT … FOR UPDATE` na observação + re-check de `status !== 'open'`, e a
evidência é **monótona**: as transições para `cancelled`/`failed` estão guardadas a `pending|processing` com CAS
(`src/lib/refunds.ts`), logo `succeeded` é terminal e a soma não pode encolher concorrentemente.

**F1b / `processing`.** A revisão independente **não encontrou nenhum caminho de produção atual** em que o C8 releia um
`processing` **commitado**: os dois únicos escritores de `status = 'processing'` são atómicos — `claimWebhookEvent` (claim +
conclusão na mesma transação de settlement; qualquer rejeição ⇒ rollback) e o claim dirigido de
`eupago-refund-recovery-service.ts` (claim + conclusão na sua própria transação; toda a rejeição pós-claim lança
`RecoveryPreconditionError` ⇒ rollback). Nenhum caller de produção passa o `db` externo, e um crash a meio da transação é
abortado pela própria base de dados. **Não há corrida concreta atual**; o tema mantém-se como **robustez/P1 latente** (2.5).

### 2.4 Revisão independente do Cycle 4 — `NO P0 BLOCKER FOUND`

Revisão adversarial **read-only** do delta `9784916 → 478e1e0e` (8 ficheiros: 3 testes novos, 1 flip de teste, 2 apenas com
comentários, `reconciliation.ts` e `eupago-settlement-service.ts`), feita contra o checkpoint e **não** contra `git diff HEAD`.

**Resultado: `NO P0 BLOCKER FOUND`.** Nenhum finding BLOCKER ou HIGH. Três MEDIUM, todos **fail-closed** ou **latentes**
(sem sequência explorável no código atual) — detalhados em 2.5.

Validações executadas no ambiente isolado garantido por `src/test-support/setup.ts` (guard de BD por
`current_database()`/`inet_server_port()`, Hyperdrive intercetado no load do módulo, `globalThis.fetch` embrulhado para
contar e **falhar** qualquer HTTP real, `EMAIL_API_KEY` removida):

| Validação | Resultado |
|---|---|
| Testes Cycle 4 (`-f1-concurrency`, `-f3`, `-f1`) | **21/21 PASS** (8 + 8 + 5) em 3,97 s |
| Suite completa no checkpoint | **1843 testes: 1828 PASS, 14 FAIL, 1 skipped** (110 ficheiros) |
| As 14 falhas | exclusivamente `c344-ssh2-e2e` e `eupago-config-routes` — famílias **pré-existentes e fora de âmbito**, não tocadas por este checkpoint (não corrigidas nem agravadas) |
| Worktree vs tree de `478e1e0e` | **396/396 ficheiros byte-idênticos** (`git hash-object`) |
| Pré-verificação do PR `origin/main...origin/arena/01a0b60b-arena` | **58 ficheiros: 30 A + 28 M + 0 D**; +19248/−390; **1 commit**; 0 binários, 0 secrets/`.env`, 0 artefactos de build, **0 ficheiros fora do âmbito Eupago P0** |
| Superset Cycle 3 ⊂ Cycle 4 | `main...9784916` = 55 ficheiros, `main...478e1e0e` = 58; delta Cycle 3→4 = 8 ficheiros com **0 eliminações** e **0 ficheiros da Cycle 3 ausentes** do tree da Cycle 4 |

Verificações adversariais que **não** revelaram problema: dupla liquidação (quatro guardas independentes — event row única e
claimável, CAS `orders WHERE status='pending_payment'`, `classifyPaidAgainstAttempt`/`recordSecondMovementTx`, trigger
`refund_attempts_balance_guard`); um perdedor não corrompe a conclusão do vencedor (`recordWebhookDeliveryFailure` tem
`WHERE status IN ('pending','failed','processing')`, logo `processed`/`anomaly`/`ignored` estão protegidos); idempotência por
fingerprint; auto-cura se a escalada pós-commit falhar (o provider repete e o gate C2 captura); a barreira do harness não é
evitável e a segunda entrega não pode bloquear no registo (a única entrada de índice em conflito é a row committed do seed e
não existe inseridor em progresso, porque o próprio INSERT da primeira entrega foi saltado por `ON CONFLICT DO NOTHING` e não
criou token especulativo).

### 2.5 Residuais P1 do Cycle 4 (não bloqueiam o rollout; todos fail-closed ou latentes)

1. **F-3 / semântica de `requiredCents` — MEDIUM, fail-closed.** `recordSettlementAnomalyTx` grava
   `observedPaidCents = input.amountCents`, i.e. o montante **do movimento divergente**, não a divergência. Numa anomalia
   criada pelo próprio F-1 com `observed > paid` (p.ex. payment de 50,00 € concluído e reentrega divergente de 60,00 € ⇒
   `expectedPaidCents=5000`, `observedPaidCents=6000`), o gate passa a exigir refunds `succeeded` ≥ 6000 para o mesmo
   `paymentId`, mas o trigger `refund_attempts_balance_guard` lança `REFUND_EXCEEDS_REFUNDABLE_AMOUNT` quando os refunds
   comprometidos excedem `payments.amount*100 = 5000`. Nessa classe, **`REFUNDED` fica estruturalmente inalcançável** — o
   operador tem de usar **`MANUALLY_RECONCILED`**, que **permanece o caminho operacional válido** e está documentado na
   mensagem de erro. Direção **segura** (nunca afirma que dinheiro foi devolvido quando não foi). **Mantém-se como
   P1/semântica**: decidir se `requiredCents` deve ser a divergência (`observedPaidCents − expectedPaidCents`, quando
   positiva) ou o montante em risco, em vez do movimento completo — economicamente, o valor em risco no exemplo é 1000, não
   6000. O comportamento atual corresponde literalmente ao critério de aceitação pedido, pelo que é uma questão de requisito
   e não um defeito de implementação.
2. **F1b / `processing` — MEDIUM, latente.** O C8 só corre a comparação semântica para `processed` ou anomalia; qualquer
   outro estado cai no fall-through `deferred / CLAIM_BUDGET_EXHAUSTED` **sem** verificação de conflito. Hoje é inalcançável
   (2.3), mas o invariante "claim e conclusão commitam atomicamente" **não está afirmado nem testado em lado nenhum**, e o
   código circundante antecipa um `processing` durável (`recordWebhookDeliveryFailure` aceita-o no WHERE;
   `grantWebhookRecoveryBudget` rejeita com `EVENT_IN_PROGRESS`). Se alguma alteração futura o tornar durável (claim fora da
   transação de settlement, settlement em duas fases ou longo, script de ops/backfill), o C8 responderia `deferred` a um
   payload divergente — e com código errado. **P1 de robustez**: tratar `processing` explicitamente no C8 ou afirmar o
   invariante no local.
3. **Dependência de READ COMMITTED — MEDIUM, latente, fail-closed.** A releitura do C8 só vê a conclusão do vencedor porque o
   PostgreSQL usa READ COMMITTED por omissão (cada statement com snapshot novo). Não há `isolationLevel` explícito em `src/`.
   Sob REPEATABLE READ/SERIALIZABLE a garantia F-1 degradar-se-ia para "apanhada num retry posterior" (a releitura devolveria
   `pending`, ou o UPDATE do claim levantaria erro de serialização ⇒ abort ⇒ `failed` ⇒ retry do provider) — sempre
   **fail-closed**, nunca `duplicate` silencioso. **P1**: documentar a dependência no local do C8 e/ou afirmar no harness que
   o isolamento efetivo é `read committed`.
4. **Menores — LOW.** `recoveryGrants` é lido do snapshot e não da row relida (direção segura: grants só aumentam, logo um
   snapshot obsoleto nunca é mais permissivo; auto-curável no retry); fingerprints alternados re-escaladam e sobrescrevem
   `metadata.eventConflict`, com amplificação **limitada a 5** ocorrências; `ignored` excluído da comparação por desenho (os
   `mismatch` que reclamam dinheiro gravam antes anomalia durável via `recordClaimedMovementConflictTx`); os cenários
   divergentes do harness não provam individualmente o C8 (o observável é idêntico ao do gate pré-transação) — a prova é
   transportada pelos cenários de payload idêntico, que partilham o mesmo harness; em falha do harness as promises das duas
   entregas ficam penduradas (sem unhandled rejection; limpeza no `beforeEach`).
5. **Documentação.** `docs/integrations/eupago-p0-cycle2-report.md:52` afirma que uma reentrega do mesmo `trid` é respondida
   `duplicate` "upstream of confirmation" — afirmação **qualificada** desde a Cycle 3/4 (só se o payload for semanticamente
   idêntico). Drift de documentação, sem impacto funcional.

### 2.6 Questões contratuais Eupago — mantidas **ABERTAS**

Os documentos existentes descrevem as **nossas** assunções, não o comportamento real do provider; nenhum constitui prova
documental. Mantêm-se **ABERTAS** até evidência contratual ou empírica da Eupago:

1. **Reutilização e semântica de `trid`** — todo o modelo C2/C8 assume que `trid` é a identidade da entrega e que um `trid`
   repetido com semântica diferente é **anomalia**, não transição legítima. Por confirmar com o provider.
2. **Transições de estado** — se `Paid → Expired` / `Cancel` / `Error` para o mesmo `trid` é transição legal ou sempre
   anomalia. O código é consistente apenas se o provider nunca reutilizar legitimamente um `trid` entre estados.
3. **Retries reais / 503 / `Retry-After`** — se a Eupago honra `503 + Retry-After`, quantas vezes repete, com que backoff, e
   se pára após `200 {received:true, anomaly:true}`. **Todo o argumento de auto-cura** (deferred H2/H3, relevância dos
   residuais 3 e 4 de 2.5) depende disto. `docs/integrations/eupago-p0-cycle2-report.md` já regista esta dependência do
   operador como aberta.
4. **Correção legítima de montante** — se o provider pode reentregar o mesmo `trid` com montante corrigido; o modelo atual
   grava anomalia em vez de aplicar a correção (interage diretamente com o residual 1 de 2.5).

### 2.7 Estado de rollout — **0017 aplicada em STAGING; código ainda não promovido para o runtime ativo**

- **PR #45 aberto**: `Harden Eupago payment integrity and reconciliation`, base `main` em `14fa0f8f5ad4293eac5e4a1917608aa23e218537` e head `64935a2cfda6ad6c62cee11dae2db22b4b03c312`. Continua **sem merge para `main`**.
- Os builds automáticos da branch criaram **Preview Versions/Alias** do `mdtech-staging`; **não há evidência de promoção deste checkpoint para o runtime ativo de `mdtech-staging` nem para produção**. O build do head `64935a2` terminou com sucesso e criou a Version ID `604d3f16-e5e5-48b3-b1b0-0ae99f8135e6` como preview.
- Em **2026-09-19**, o diagnóstico **READ-ONLY / virgin-ledger** foi executado contra **Neon STAGING** e devolveu `VIRGIN`: zero registos Eupago nas tabelas relevantes e migration 0017 ainda ausente nesse momento.
- A migration **`0017_eupago_p0_ledger_integrity.sql` foi depois aplicada exclusivamente em Neon STAGING**, através de ligação **DIRECT / Pooling OFF**, database `neondb`, role proprietária `mdtech_staging`.
- O artefacto aplicado foi validado imediatamente antes da execução: **10393 bytes**, SHA-256 canónico **`cdd77fdb243dd8d14ae368dd58bbb703f3fc7d7fc8fa779e1676d3ac6c1f3dbb`**.
- `drizzle-kit migrate` terminou com **exit 0**. O bookkeeping ficou com **18 migrations**, 0017 em `id=18`, `created_at=1789692309756`, hash igual ao SHA-256 canónico e **zero migrations posteriores**.
- O POST-CHECK READ-ONLY devolveu **`STEP2_OK_0017_APPLIED_COMPLETE`**: 6 colunas esperadas, 3 índices, 3 FKs, 2 funções e 2 triggers novos presentes; `recorded_by` passou a nullable e os defaults de `operation_revision` são `0`.
- A comparação estrutural PRE → POST confirmou **exclusivamente o delta esperado da 0017**: 1237 → 1254 objetos; COL +6, CON +4, IDX +3, FN +2, TRG +2 e TBL 0. Não foram detetadas alterações estruturais alheias à migration.
- **A 0017 não deve ser executada novamente em STAGING**: é não-idempotente e o Step 2 está concluído.
- **Produção não foi migrada nem recebeu este código.**
- Fazer merge do PR em `main` não deve ser tratado como mecanismo de migration. A ordem de rollout continua controlada: migration validada em STAGING → deploy do código correspondente → E2E/sandbox → validação contratual restante.
- **Nunca `db:push`** para instalar/reaplicar a 0017 (regra mantida, ver 2.1).
- Nenhum pagamento/referência real foi criado contra a Eupago durante este Step 2 e nenhum segredo é registado neste documento.

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
- **Checkpoint PAYMENT/Eupago P0 ainda sem promoção para o runtime ativo** — PR #45 aberto, head `64935a2cfda6ad6c62cee11dae2db22b4b03c312`, **sem merge para `main`**. A migration 0017 foi aplicada **apenas em Neon STAGING** em 2026-09-19, após virgin-check `VIRGIN`, e o Step 2 foi validado integralmente (ver 2.7).

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
