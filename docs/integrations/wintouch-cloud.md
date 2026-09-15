# Wintouch Cloud — integração Arena (fase C.4: PROBE read-only)

> Estado: **PROBE**. Existe cliente HTTP + diagnóstico read-only. **Não há
> criação de documentos, não há escrita na BD, não há rotas HTTP novas e não
> há qualquer chamada automática.** A faturação automática é uma fase futura
> e depende da informação listada em “Informação ainda necessária”.

## 1. Configuração

| Variável | Obrigatória | Conteúdo |
|---|---|---|
| `WINTOUCH_API_BASE_URL` | Sim | BaseAddress do tenant: scheme + host + prefixo até à raiz dos recursos (ex.: `https://<tenant>/api`), **sem** trailing slash. |
| `WINTOUCH_API_KEY` | Sim | API key da conta (secret). |

Regras de validação (`src/lib/providers/wintouch/config.ts`, fail-closed):

- Base URL: tem de ser URL absoluto `https` (http só em loopback para dev/testes);
  sem userinfo, sem query string, sem fragmento; trailing slashes removidas.
- API key: não-vazia; rejeita `\r \n \0` (injeção de header).
- Em falha, o erro indica **apenas o nome da variável**, nunca o valor.

## 2. Secrets

- Produção/staging: secret bindings (`wrangler secret put WINTOUCH_API_KEY`;
  a base URL vai em `wrangler secret` ou `vars`? **Decisão: `vars` só se o
  tenant for público por natureza; por omissão, tratar também como secret**).
  Nunca em `wrangler.jsonc` versionado, nunca na BD, nunca em logs.
- Local: `.env` (gitignored). O script de probe carrega `.env`
  automaticamente via `dotenv/config`.
- A key viaja apenas no header `Authorization: ApiKey <key>` — nunca no URL.
- Sanitização: `sanitizeErrorMessage` (`src/lib/providers/errors.ts`) redacta
  o esquema `ApiKey <key>` além dos padrões pré-existentes; o probe aplica
  ainda `redactSecrets` (remoção determinística da key conhecida) a todos os
  campos derivados da API **e** uma varredura final ao JSON serializado.
  Testes adversariais (`wintouch-probe.test.ts`) provam que a key nunca sai,
  mesmo que a API a ecoe em valores, nomes de campos ou corpos de erro.

## 3. Autenticação e endpoints usados

- Autenticação: `Authorization: ApiKey <APIKEY>`, exatamente como o ApiDemo
  oficial inicializa a API.
- Allowlist literal de recursos (validados a partir do ApiDemo; nada inventado):

| Endpoint interno | Path |
|---|---|
| `documentTypes` | `/Document_Types` |
| `paymentMethods` | `/payment_methods` |
| `entities` | `/entities` |
| `productDocuments` | `/product_documents` |

Composição do URL: `WINTOUCH_API_BASE_URL + path`. Se a conta real exigir
outro prefixo, muda-se **só o env**, sem código. Tipos de documento do
ApiDemo (referência, a confirmar na conta): SalesQuote=1, SalesOrder=2,
CashSaleInvoice=3, SalesInvoice=5, SalesCreditNote=6, DeliveryOrder=7,
SimplifiedCashSaleInvoice=40.

## 4. Probe

Serviço: `probeWintouch()` em `src/lib/providers/wintouch/probe.ts`.
Script: `src/scripts/wintouch-probe.ts`.

Comando exato:

```bash
WINTOUCH_API_BASE_URL=https://<tenant>/api WINTOUCH_API_KEY=<key> npx tsx src/scripts/wintouch-probe.ts
```

(ou preencher ambas no `.env` e correr `npx tsx src/scripts/wintouch-probe.ts`)

O probe corre 4 GETs sequenciais (Document_Types, payment_methods, entities,
product_documents — este último desligável via `includeProductDocuments:
false`) e devolve **apenas**: `ok`, `baseUrl`, `authenticated`, por check
(`name`, `endpoint`, `ok`, `status`, `outcome`, `reason`, `count`,
`shape` = nomes de campos ordenados, `error` = excerto sanitizado ≤300
chars), `durationMs`, `probedAt`.

Exit codes: `0` tudo 2xx · `1` uso/config inválida (nada foi pedido) ·
`2` probe correu com falhas. stdout = JSON puro; stderr = resumo de 1 linha.

## 5. Tratamento de erros

Contrato herdado do transporte Eupago (`src/lib/providers/eupago/client.ts`):

- `ok` (qualquer status não-5xx + corpo parsed): inclui 401/403/400/404 —
  respostas **definitivas** com status e corpo de erro preservados.
- `ambiguous`: `timeout` / `network_error` / `server_error` (5xx) /
  `malformed_response`. O provider pode ou não ter executado — nunca se
  re-tenta uma criação às cegas, nunca se interpreta como ausência.
- O transporte faz **uma** tentativa; retry é decisão de domínio. Timeout
  default 15s por pedido (AbortController), configurável por chamada.
- 401/403 = key rejeitada (definitivo, sem retry). `authenticated=true`
  significa “≥1 endpoint respondeu com status fora de 401/403”.

## 6. Fluxo futuro (NÃO implementar nesta fase)

```
Arena order → Eupago payment → payment confirmed (Arena)
    → invoice pending → invoice processing → invoice created/failed (Arena)
    → Wintouch product_documents (POST único) → document ID / number / ATCode → Arena
```

Regras:

- O Eupago **nunca** cria a fatura diretamente; só confirma pagamento.
- `paymentStatus = paid` **não** dispara faturação sozinho — dispara a
  transição para `invoice pending`, e um passo explícito/idempotente reclama
  e executa a criação.
- Sem cron/auto-apply nesta fase; o mecanismo de disparo (manual admin,
  worker, fila) decide-se na fase de criação.

## 7. Idempotência (preparação)

Reutilizar a estrutura existente — **não criar tabelas paralelas**:

- Tabela `invoice_documents` (`src/db/schema.ts`): `orderId`, `provider`,
  `documentType` (invoice|credit_note), `providerDocumentId`,
  `documentNumber`, `series`, `status` (pending|issued|failed|cancelled),
  `issuedAt`, `documentReference`, `amountCents`… com unique
  `(provider, providerDocumentId)`.
- Helpers em `src/lib/providers/invoice-provider.ts`: `createInvoiceDocument`
  (abre `pending`), `markInvoiceDocumentIssued` / `markInvoiceDocumentFailed`
  (transições atómicas com guarda `status='pending'` no próprio UPDATE;
  `issued` é imutável e idempotent-replay em `failed`/`cancelled`).
- Mapeamento da máquina pedida: `pending` (criada) → `processing`
  (reclamação atómica; ver DDL) → `issued` (= created) / `failed`.
  O estado `processing` não existe hoje em `INVOICE_DOCUMENT_STATUSES`;
  opções: (a) adicionar `"processing"` por migração; (b) reclamar via
  `pending` + coluna de claim. Decidir na fase de criação.

DDL prevista para a fase de criação (aditiva, não-destrutiva — **não criar
agora**, documentada para revisão):

```sql
-- Uma fatura Wintouch por encomenda: a chave de idempotência vive na BD.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_documents_one_wintouch_invoice_per_order
  ON invoice_documents (order_id, provider, document_type)
  WHERE provider = 'wintouch' AND document_type = 'invoice' AND source = 'wintouch';
```

(Se `source` passar a espelhar o provider para documentos de provider, o
predicado simplifica-se. Notas fiscais seguem o padrão `manual` existente.)

Passos obrigatórios da fase de criação (fora desta fase):

1. Registar `"wintouch"` em `INVOICE_PROVIDERS` (`registry.ts`) com as
   capabilities suportadas (começar só por `createInvoice`+`getDocument`).
2. Implementar `InvoiceProviderAdapter` para Wintouch (construção do
   `ProductDocumentMaster` a partir de `orders`+`order_items`+`users`/
   `addresses`; valores via `money-boundary.ts`, em cêntimos).
3. Migração aditiva com o unique index acima (+ `processing` se adotado).
4. Claim-before-create: inserir linha `pending` (a constraint resolve
   corridas) → POST único → `markInvoiceDocumentIssued/Failed`.
   `ambiguous` no POST → estado de reconciliação, **nunca** re-POST cego
   (padrão `payment_attempts.recovery_state` do Eupago).
5. Nunca apagar documentos emitidos (regra fiscal já documentada em
   `invoice-provider.ts`); correções via credit note no provider.

## 8. Informação ainda necessária da conta Wintouch

Sem isto não se pode construir o POST de criação (não assumir UUIDs):

1. `DocumentTypeID` da fatura de venda online (e do crédito, se aplicável).
2. `DocumentSerieID` da série de faturação online.
3. `PaymentMethodID`s dos métodos relevantes (MB, MB WAY, cartão…).
4. Forma real de `entities` (singular? pesquisa por NIF/código?) e sintaxe de
   filtros suportada (`$filter`? query simples? — **não validado**).
5. Forma real de artigos/`ProductID` (criar a pedido? pré-existentes?) e
   obrigatoriedade de `StockUnitID` / `WharehouseID`.
6. `VATID`s por taxa (23/13/6…) e semântica `VATIncluded` esperada.
7. Resposta do POST `product_documents` (ID interno? número? série? ATCode /
   hash fiscal?) para correlação idempotente.
8. Envelope de erro (formato do corpo em 400/401/422) e rate limits.
9. Confirmação da composição exata do URL (prefixo até aos recursos).

## 9. Ficheiros desta fase

- `src/lib/providers/wintouch/config.ts` — config fail-closed + allowlist.
- `src/lib/providers/wintouch/client.ts` — transporte (GET/POST tipado).
- `src/lib/providers/wintouch/probe.ts` — diagnóstico read-only seguro.
- `src/lib/providers/wintouch/wintouch-client.test.ts` — unit (mock).
- `src/lib/providers/wintouch/wintouch-probe.test.ts` — unit (mock).
- `src/lib/providers/wintouch/wintouch-live.test.ts` — live, só com env.
- `src/scripts/wintouch-probe.ts` — CLI do probe.
- `src/lib/providers/errors.ts` (+1 padrão `ApiKey`) e caso de teste em
  `provider-errors.test.ts` — único toque em código partilhado, aditivo.
