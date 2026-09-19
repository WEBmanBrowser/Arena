# Eupago P0 — Cycle 2 report (independent review BLOCKED → fixes)

Base: `main` @ `14fa0f8f5ad4293eac5e4a1917608aa23e218537`
Branch: `arena/01a0b1f0-arena` (single checkpoint `e338f948` already pushed; this cycle produced NO new commit/push — by instruction)
Status: **all cycle-2 edits live in the working tree, uncommitted**
Cycle-1 document (`docs/integrations/eupago-p0-report.md`, verdict “READY FOR FINAL REVIEW”) is **superseded** by this cycle: the review returned BLOCKED and the findings below were fixed.

Cycle-2 delta vs the pushed checkpoint `e338f948`: **19 files (16 modified, 3 new) — 2263 insertions, 64 deletions** (measured with `git diff --shortstat e338f948 73c69c62`; an earlier revision of this line said 17 files / 15 modified / 2 new, which did not match the real delta).
The whole P0 body of work (cycle 1 + cycle 2) is uncommitted relative to `14fa0f8f` — see section I.

---

## A. Files touched in cycle 2 (vs checkpoint `e338f948`)

Modified (16):

| file | why |
| --- | --- |
| `src/lib/orders.ts` | HIGH-1/HIGH-2 — coherence gate in `confirmOrderPaymentInTx` |
| `src/lib/services/eupago-settlement-service.ts` | HIGH-1 (anomaly outcome), HIGH-2 (LATE_PAID), HIGH-3/H2 (deferred) |
| `src/lib/providers/webhook-events.ts` | L1 atomic grant, L6 retryability, defer/claim semantics |
| `src/lib/services/eupago-refund-service.ts` | L2 deterministic paid-attempt selection, L5 gate |
| `src/lib/services/eupago-payment-service.ts` | L5 gate on `recoverPaymentAttempt` |
| `src/lib/providers/errors.ts` | `MIGRATION_REQUIRED_0017` code surfaced to operators |
| `src/lib/email-outbox.ts` | MEDIUM-2 — stranded-claim control + requeue dispatches |
| `src/lib/email-outbox` route `src/app/api/admin/email-outbox/[id]/requeue/route.ts` | MEDIUM-2 — real post-commit dispatch |
| `src/app/api/webhooks/eupago/route.ts` | HIGH-3/H2 — deferred ⇒ 503 + `Retry-After` |
| `src/db/schema.ts` | schema/DDL alignment (`refund_attempts.operation_revision`, L3 linkage guard) |
| `drizzle/0017_eupago_p0_ledger_integrity.sql` | DDL for `operation_revision` + immutability trigger |
| `drizzle/meta/0017_snapshot.json` | MEDIUM-1 — snapshot parity with the DDL |
| `drizzle/meta/_journal.json` | 0017 journal entry |
| `src/lib/payments-p0-outbox.test.ts` | new dispatch/stranded-claim/concurrency tests |
| `src/lib/payments-p0-migration-0017.test.ts` | DDL↔snapshot parity assertions |
| `docs/integrations/eupago-p0-report.md` | cycle-1 report marked as superseded (review verdict BLOCKED) |

New (3):

| file | why |
| --- | --- |
| `src/lib/services/financial-anomalies.ts` | durable anomaly read/write model (`reconciliation_observations`, `payment_anomaly`) |
| `src/lib/payments-p0-anomalies.test.ts` | HIGH-1/HIGH-2 end-to-end anomaly suite (14 tests) |
| `docs/integrations/eupago-p0-cycle2-report.md` | this report (A–J; delta measured above) |

Not touched in cycle 2 (verified by blob comparison against `e338f948`): all other P0 files, in particular `src/lib/eupago-config-routes.test.ts`, `src/app/api/admin/settings/eupago/route.ts`, auth/CSRF modules, Cloudflare config, Wintouch, checkout payment-method wiring.

---

## B. Per-finding fix

**HIGH-1 — second Paid / ledger incoherence.** `confirmOrderPaymentInTx` now has a fail-closed coherence gate (`settlementMustBeCoherent: true`, used by the provider path only):
* the AUTHORITATIVE rows are read **under lock, before any write**; a refusal writes nothing (no order transition, no stock movement, no audit, no outbox row);
* an order that is no longer `pending_payment` is refused **unconditionally** (`ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT` when paid, else `ORDER_NOT_SETTLEABLE`) — the old `coherentRepeat` shortcut is **gone**, because a same-trid redelivery is answered `duplicate` upstream of confirmation;
* the attempt’s `paymentId` remains the ONLY confirmation candidate; other pending payment rows are never touched;
* the settlement service turns a refusal into `outcome: "payment_anomaly"`: attempt stays `paid`, durable anomaly (`DOUBLE_CHARGE`, `PAYMENT_NOT_COHERENT`, `LATE_PAID`) + audit `payment.provider_anomaly_recorded` + `provider_webhook_events.status = 'anomaly'` (never `processed`), with the second movement’s trid retained (`movementId`);
* a paid attempt carrying a **different** trid (`PROVIDER_TRANSACTION_CONFLICT`) records `PAYMENT_NOT_COHERENT` and keeps the movement; the attempt keeps its original settled trid;
* operational read-model: `listSettlementAnomalies` / `settlementAnomalySummary` expose code, amount, currency, order, payment, movement and state — money needing reconciliation/refund is visible and never auto-fixed.

**HIGH-2 — LATE_PAID.** A valid authenticated Paid that lands after expiry / cancellation / internal payment cancellation is **never** downgraded to a technical error or discarded: the attempt is marked paid, `LATE_PAID` is recorded durably (trid, attempt, canonical payment, amount, currency, order, anomaly state), the event is `anomaly` (not `processed`), and there is **no** auto reactivation, **no** stock change and **no** automatic refund. A later refund stays bound to the correct canonical payment and its `originalTrid`; a blind refund is impossible — `armEupagoRefund` refuses (`OPERATION_NOT_SUPPORTED`) while the canonical payment is not settled; same trid stays idempotent.

**HIGH-3 / H2 — deferred ack + re-drive.** An authenticated delivery whose correlation cannot be established *yet* (Multibanco reference not yet persisted on the attempt) is parked in the re-evaluable `pending` state (`deferred / DEFERRED_REFERENCE_NOT_YET_PERSISTED`) instead of becoming terminal `ignored`. The HTTP route answers **503 + `Retry-After: 60`** (`{received:false, retry:true, outcome:"deferred"}`) so the provider’s own retry is the bounded re-drive; the same trid re-attempts correlation and settles exactly once. No internal loop, no cron, no unbounded scheduler; when a delivery budget is exhausted the event needs the audited admin grant-recovery path (H3). An identifier that matches no local attempt is a definitive divergence (`mismatch`), not a deferral.

**MEDIUM-1 — `0017_snapshot.json`.** `refund_attempts.operation_revision` added and the snapshot regenerated to match the DDL exactly (columns, FKs, indexes, triggers, journal). Verified with drizzle-kit (no `db:push`, disposable DB only): “No schema changes”. Parity is asserted by `payments-p0-migration-0017.test.ts`.

**MEDIUM-2 — requeue really dispatches.** After the audited requeue commits, `redispatchRequeuedNotification` performs **one** dispatch post-commit with the real transport, and the admin route returns `{outcome, code, dispatch}` (`sent` / `failed` / `delivery_unknown` / `not_attempted`). Requeue stays admin-only + CSRF + audited; the body is empty (nothing caller-supplied is re-sent). No email is ever enqueued or sent inside the financial transaction; there is no automatic retry (a `delivery_unknown` row is only ever re-driven by an explicit operator action); a stranded claim is refused with `CLAIM_STILL_ACTIVE` until it ages past `STRANDED_CLAIM_MS` (15 min), and the explicit sweep recovers crash-between-requeue-and-dispatch. Concurrency yields exactly one transport call.

**L1 — `grantWebhookRecoveryBudget`** is now an atomic conditional UPDATE/claim (never read-then-write), including for `EVENT_FINANCIAL_ANOMALY`; the budget remains `MAX_RECOVERY_GRANTS = 2` and a grant by itself never settles anything.
**L2 — `armEupagoRefund`** selects the paid attempt deterministically (ascending id, non-empty provider transaction id); `0` ⇒ `PAYMENT_NOT_FOUND`, `>1` incompatible ⇒ `AMBIGUOUS_PROVIDER_MOVEMENT`, and an unsettled canonical payment ⇒ `OPERATION_NOT_SUPPORTED`.
**L3/G4 — linkage immutability**: `payment_attempts.payment_id` (and the provider linkage) cannot be re-pointed once non-null (trigger), while new Eupago attempts remain mandatorily linked.
**L4/B1 — rollout**: migration-first-with-old-code only under **ZERO** Eupago traffic, diagnosis strictly READ-ONLY and it never assumes a virgin ledger (`scripts/eupago-ledger-virgin-check.cjs`: SELECT/COUNT only, `--json`, refuses remote unless `--allow-remote`; never run against the real DB).
**L5 — fail-closed entrypoints**: `assertEupagoLedgerReady` is the first statement of the settlement transaction and is also gated at `executeEupagoRefund` and `recoverPaymentAttempt`, surfacing an explicit operational `MIGRATION_REQUIRED_0017 missing: …` instead of a raw SQL error; no circular imports.
**L6 — no dead retryability**: `isRetryable` / `listRetryableWebhookEvents` exclude `anomaly` and unrelated metadata; the remaining definitions are used and semantically coherent with the grant path.

---

## C. New / changed tests

| suite | tests | covers |
| --- | --- | --- |
| `src/lib/payments-p0-anomalies.test.ts` (new in cycle 2) | 14 | HIGH-1 (a/b/c), HIGH-2 (expired, cancelled, redelivery), gate cases (orphan ⇒ `PAYMENT_NOT_FOUND`, already-paid ⇒ `PAYMENT_ALREADY_SETTLED`, cancelled ⇒ `ORDER_NOT_SETTLEABLE`), repeat ⇒ `ORDER_ALREADY_SETTLED_BY_OTHER_MOVEMENT`, no extra stock decrement (`soldCount`), canonical payment identifiable, refund refusal (`OPERATION_NOT_SUPPORTED`) + evidence via `listSettlementAnomalies`, route-level anomaly 200 |
| `src/lib/payments-p0-outbox.test.ts` | 17 | MEDIUM-2: no auto retry, admin requeue + real dispatch, crash between steps recoverable only by explicit sweep, stranded claim ⇒ `CLAIM_STILL_ACTIVE`, concurrency ⇒ one send, `delivery_unknown` never swept, sent-row ⇒ 409, eventKey/dedupe |
| `src/lib/payments-p0-migration-0017.test.ts` | 14 | real `0000 → 0017` on a scratch DB + DDL↔snapshot parity (`operation_revision`, FKs, indexes, triggers, journal) |
| `src/lib/payments-p0-h2-h3.test.ts` | 6 | deferred → re-evaluation → settle exactly once, budget exhaustion, audited grant |
| `src/lib/payments-p0-ledger.test.ts` | 14 | canonical provisioning, ledger-environment fail-closed |
| `src/lib/payments-p0-http-locks-refunds.test.ts` | 14 | no HTTP inside the tx, lock order, refund claim-before-POST, UNKNOWN never re-armed |
| `src/lib/b32-eupago-h2-h3.test.ts` | 5 | route/webhook H2/H3 integration |
| `src/lib/providers/eupago/events-h1.test.ts` | (part of the 12-file/215-test eupago filter) | H1 parsing/aliases |

Changed tests in cycle 2: `payments-p0-outbox.test.ts` (MEDIUM-2 behaviour), `payments-p0-migration-0017.test.ts` (snapshot parity), plus the HIGH-1(c)/LATE_PAID adjustments inside `payments-p0-anomalies.test.ts` and the env save/restore for `EUPAGO_WEBHOOK_KEY` in the route-level describe.
Harness isolation hardening: `payments-p0-anomalies.test.ts` now deletes the operator users it creates (matched by its own email prefix) **after** its financial rows, so the suite can never leave a user row behind for another file in the shared embedded PG.

---

## D. Validation commands

```
npx tsc --noEmit
npm run lint
npm test payments-p0
npm test eupago payment-attempts refunds events-h1
npm test eupago-config-routes
npm test eupago-config-routes c342-preview-reopen
npm test eupago-config-routes c342-preview-reopen b41-dashboard b34a-operational-commerce b22-customers payments-p0   (×3)
npm test                       (full suite, ×2)
git diff --check ; git status --short
```

Isolation guarantees actually in force for every run above: embedded PostgreSQL 18.4 in a temp dir (`os.tmpdir()`), `drizzle-kit migrate` (versioned path) on that disposable DB, no inherited real `DATABASE_URL`, no real Hyperdrive, `ARENA_TEST_GUARD=1`, Cloudflare and real HTTP blocked, `EMAIL_API_KEY` deleted, no real Eupago/Wintouch call, no `db:push`, no real migration anywhere.

---

## E. Exact results

| command | result |
| --- | --- |
| `npx tsc --noEmit` | clean (0 errors) |
| `npm run lint` | 0 errors, 6 warnings (all pre-existing) |
| `npm test payments-p0` | 6 files / **79 passed** |
| `npm test eupago payment-attempts refunds events-h1` | 12 files / **215 passed** |
| `npm test eupago-config-routes` | 1 file / **13 passed** |
| `npm test eupago-config-routes c342-preview-reopen` | 2 files / **35 passed** |
| combined 12-file run ×3 | **236 passed** each time |
| **`npm test` (full, ×2 in this session)** | **102 files passed / 1 failed / 1 skipped (104)**; **1796 passed / 1 failed / 1 skipped (1798)** — the single failure is the pre-existing `c344-ssh2-e2e` timing test (“enforces the stream limit when STAT lies”), unrelated to P0 |
| `git diff --check` | clean (exit 0) |

Note on the full run: the review-cycle full run (previous session) showed 13 `eupago-config-routes` failures caused by its `afterEach` cleanup (`DELETE FROM users WHERE id = 990044` → FK `orders_user_id_users_id_fk`). That file is **unmodified** by this patch (blob-identical to `e338f948`), it is green in isolation and in every combination run, and the two full runs of this session are green for it. Classified as flaky cross-suite interference on the shared embedded PG (fixed operator ids in pre-existing suites vs other files inserting orders for users they create); the isolation hardening in section C removes this patch’s contribution to it. It is **not** reported as fixed-by-right, and it is not hidden.

---

## F. Tests not run (and why)

- No test was run against any real/staging/production database, no real Eupago or Wintouch endpoint, no real migration on a non-disposable DB — isolation cannot be guaranteed there, so by protocol those runs simply do not happen.
- `scripts/eupago-ledger-virgin-check.cjs` was **not** executed against any real database (it is a deploy-time, READ-ONLY diagnosis; running it needs the operator and the real URL).
- No load/soak test of the webhook route (would need a real provider retry policy) and no manual QA of the admin outbox/anomaly screens (needs a live session) — explicitly out of scope for this cycle.
- The ALSO import domain (stock, automatic price updates, product deactivation/discontinuation) was **not** touched; it is the next, separate checkpoint.

---

## G. Residual risks

1. **Operator dependency for deferred deliveries**: recovery relies on the provider actually retrying (503 + `Retry-After`) or on the audited admin grant path. If Eupago gave up before the local reference existed, the movement only exists in the provider’s side until an operator reconciles — nothing is silently lost, but it needs a human.
2. **Manual reconciliation of `LATE_PAID` / `DOUBLE_CHARGE`**: the system preserves evidence and refuses blind refunds; the money itself is returned through the operator-driven refund/reconciliation flow, tied to the correct canonical payment.
3. **`delivery_unknown` mail**: never automatically re-sent (by design). An operator must decide; if they never do, the customer never gets that notification.
4. **Flaky full-suite failure in `eupago-config-routes`** (see E): not reproduced after the hardening, not proven eliminated.
5. **Migration ordering**: 0017 must be installed before the new code and only under zero Eupago traffic (B1/L4). The checkout is still `bank_transfer`-only, which is what makes that constraint satisfiable today.
6. **Snapshot parity is test-enforced, not generated at deploy time** — anyone editing `0017` DDL must regenerate the snapshot and run the parity suite.

---

## H. Gate status

| gate | status | evidence |
| --- | --- | --- |
| **G1** atomic settlement in one DB tx, no HTTP inside | **PASS** | `eupago-settlement-service` composes claim + attempt CAS + confirmation + audit + outbox in one tx; `payments-p0-http-locks-refunds` asserts the fetch counter stays 0 inside |
| **G2** refund claim committed before POST, UNKNOWN never frees/re-arms | **PASS** | claim-before-HTTP + revision fencing; UNKNOWN leaves the claim in place; `payments-p0-http-locks-refunds` / `refunds` |
| **G3** strict FOUND / PROVEN_ABSENT / UNKNOWN, no real-HTTP PROVEN_ABSENT | **PASS** | recovery service + `b352-eupago-recovery`, ledger suite |
| **G4** canonical order→payment→attempt chain, refund→payment, server-authoritative amount/currency/method | **PASS** | composite FKs + `resolveCanonicalPayment`, L3 immutability trigger, amount/currency checks in the settlement tests |
| **D1** no rounding, no substring method guessing, conflicting aliases rejected | **PASS** | `INVALID_AMOUNT`, closed alias sets, `CONFLICTING_*_ALIASES` (events-h1) |
| **D2** sandbox/production ledgers never mixed, unknown history never silently classified | **PASS** | internal `eupago_ledger_environment` setting, fail-closed `PROVIDER_UNAVAILABLE` (ledger suite) |
| **B1** migration-first-with-old-code only under zero Eupago traffic, READ-ONLY diagnosis, never assume virgin | **PASS** | `docs/integrations/eupago-p0-rollout.md` matrix + `scripts/eupago-ledger-virgin-check.cjs` (read-only, refuses remote by default) + parity tests |
| **H2** deferred ack without re-drive | **PASS** | `deferred` → 503 + `Retry-After: 60` (route test), parked `pending` (never terminal `ignored`), same trid settles exactly once |
| **H3** bounded budget, audited grant, grant never settles by itself | **PASS** | `MAX_RECOVERY_GRANTS = 2`, atomic grant, `CLAIM_BUDGET_EXHAUSTED` ⇒ `deferred`, grant endpoint admin+CSRF+audited |

---

## I. `git status --short`

```
 M docs/ARENA-CONTINUITY.md
 M drizzle/meta/_journal.json
 M scripts/test-runner.cjs
 M src/app/api/orders/route.ts
 M src/app/api/webhooks/eupago/route.ts
 M src/db/schema.ts
 M src/lib/audit.ts
 M src/lib/b32-eupago-lifecycle.test.ts
 M src/lib/b32-eupago-webhook-route.test.ts
 M src/lib/b35-refunds.test.ts
 M src/lib/b352-eupago-recovery.test.ts
 M src/lib/b41-dashboard.test.ts
 M src/lib/orders.ts
 M src/lib/providers/errors.ts
 M src/lib/providers/eupago/eupago-payments.test.ts
 M src/lib/providers/eupago/events.ts
 M src/lib/providers/eupago/recovery.ts
 M src/lib/providers/payment-attempts.test.ts
 M src/lib/providers/payment-attempts.ts
 M src/lib/providers/webhook-events.ts
 M src/lib/refunds.ts
 M src/lib/services/eupago-payment-service.ts
 M src/lib/services/eupago-refund-service.ts
 M src/lib/services/eupago-settlement-service.ts
 M vitest.config.ts
?? docs/integrations/eupago-p0-report.md
?? docs/integrations/eupago-p0-rollout.md
?? drizzle/0017_eupago_p0_ledger_integrity.sql
?? drizzle/meta/0017_snapshot.json
?? scripts/eupago-ledger-virgin-check.cjs
?? src/app/api/admin/email-outbox/
?? src/app/api/admin/webhook-anomalies/[id]/grant-recovery/
?? src/lib/b32-eupago-h2-h3.test.ts
?? src/lib/email-outbox.ts
?? src/lib/payments-p0-anomalies.test.ts
?? src/lib/payments-p0-h2-h3.test.ts
?? src/lib/payments-p0-http-locks-refunds.test.ts
?? src/lib/payments-p0-ledger.test.ts
?? src/lib/payments-p0-migration-0017.test.ts
?? src/lib/payments-p0-outbox.test.ts
?? src/lib/providers/eupago/events-h1.test.ts
?? src/lib/services/eupago-ledger-service.ts
?? src/lib/services/financial-anomalies.ts
?? src/lib/stock-locks.ts
?? src/test-support/
```

(45 entries: 25 modified, 20 untracked paths; nothing staged, nothing committed, nothing pushed.)

---

## J. `git diff --check`

```
$ git diff --check
$ echo $?
0
```

Clean — no whitespace errors, no conflict markers, in the tracked diff.

---

## Verdict

The three BLOCKED findings (HIGH-1, HIGH-2, HIGH-3/H2) and the five MEDIUM/LOW findings (MEDIUM-1, MEDIUM-2, L1–L6) are fixed with tests; G1–G4, D1, D2, B1, H2, H3 are PASS. Remaining known items are the residual risks in section G (all operational, none silently auto-fixed) and the unreproducible full-suite flake described in section E.

No commit, no push, no PR, no deploy — awaiting your instruction. Next domain (separate checkpoint, on your word): import — stock, automatic price updates, product deactivation/discontinuation.
