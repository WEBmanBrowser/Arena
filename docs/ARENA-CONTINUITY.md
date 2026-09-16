# Arena — Continuidade técnica

> Documento de continuidade técnica do projeto Arena. Regista, de forma
> objetiva e verificável, o estado do repositório, checkpoints concluídos,
> decisões vigentes e regras de segurança/continuidade. Deve ser atualizado a
> cada checkpoint relevante. **Nunca incluir secrets neste documento.**

Última atualização: 2026-09-15

---

## 1. Checkpoint atual

| Ref | SHA | Notas |
|---|---|---|
| Base anterior | `2bf3fa609d5c941347c050ec1f365f0e1ac3b5ce` (`2bf3fa6`) | Merge do PR #40 (`arena/wintouch-cloud-integration`); ponto de partida deste ciclo |
| Checkpoint Eupago | `5c1e6c4ff2cf8809607dab322d76c0eeb0a8e2c1` (`5c1e6c4`) | "Add secure Eupago backoffice configuration"; branch `arena/01a0a6e6-arena`; feito push para `origin` |

Working tree: **clean** no momento deste registo. Sem PR aberto, sem merge, sem deploy do checkpoint Eupago.

---

## 2. Eupago — configuração segura pelo Backoffice (CONCLUÍDO)

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

## 3. Validações reproduzidas (checkpoint Eupago)

| Validação | Resultado |
|---|---|
| Patch recuperado vs checkpoint original | **17/17 ficheiros byte-exatos** (blobs idênticos) |
| Lint (`eslint .`, sem `--fix`) | **exit 0** — 0 erros, 9 warnings pré-existentes fora do patch |
| Testes focados (`settings-secrets`, `eupago-config-service`, `eupago-config-routes`, `admin-settings-isolation`) | **4/4 ficheiros PASS, 54/54 testes PASS** (Postgres embutido via `scripts/test-runner.cjs`) |
| `git diff --check` | **clean** (exit 0, sem output) — incluindo os 10 ficheiros added via `--no-index` |

---

## 4. Estado operacional Eupago

- **Sem secrets reais configurados** — nem no repositório nem neste documento. Antes de guardar o primeiro segredo no Backoffice: `wrangler secret put SETTINGS_ENCRYPTION_KEY` (ver doc de operação).
- **Sem pagamento real de teste** — nenhum pagamento/referência real foi criado contra a Eupago neste ciclo.
- **Sem deploy deste checkpoint** — o commit `5c1e6c4` está pushed mas ainda não foi deployado para staging/produção.

---

## 5. Wintouch C.4 — estado e decisão

- **PROBE read-only** já integrado na base (`2bf3fa6`): cliente HTTP + diagnóstico sem escrita (ver `docs/integrations/wintouch-cloud.md`).
- **API key validada através do DB Manager / consulta de enterprises; os endpoints Legacy testados continuam com HTTP 500.**
- **Decisão**: aguardar suporte Wintouch. **Não alterar C.4 entretanto.**

---

## 6. ALSO — separação pricelist / stock

- Manter **rigorosamente separados** `pricelist-1.txt` e `stock.txt` (fontes, parsing, pipelines e efeitos).
- **`pricelist-1.txt`**: gere catálogo e preços; **não** toca em stock físico.
- **`stock.txt`** (stock feed): atualiza **apenas** disponibilidade e `product_suppliers.supplier_stock`; **não cria produtos**; **não altera** preços, categorias nem `products.stock`.

---

## 7. ALSO — próximo trabalho planeado (categorias)

- Preservar `CategoryText1`, `CategoryText2`, `CategoryText3` **separadamente** (não concatenar).
- Implementar hierarquia **`CategoryText1` → `CategoryText2` → `CategoryText3` → Produto**.
- Criação/reutilização **idempotente** de categorias, com **parent correto** em todos os níveis.
- **Slugs globais determinísticos e collision-safe** (estáveis entre runs, sem colisões entre níveis/fornecedores).
- O **stock feed nunca toca em categorias** (regra da secção 6 mantém-se).

---

## 8. Sentinel `1410065407`

- O sentinel `1410065407` **continua por resolver**.
- **Não reinterpretar** o seu significado ou tratamento **sem nova evidência** (dados novos do ALSO/Wintouch ou diagnóstico concreto). Manter o comportamento atual até lá.

---

## 9. Regras de segurança/continuidade

1. **Não colocar secrets no Git** — credenciais/chaves vivem em env/`wrangler secret put`; documentos e código nunca as contêm.
2. **Não misturar alterações ALSO/Eupago/Wintouch no mesmo checkpoint** — um checkpoint, um domínio.
3. **Validar antes de commit/deploy** — lint + testes focados + `git diff --check` no mínimo (padrão usado no checkpoint Eupago).
4. **Não executar apply dos previews ALSO `#1014`/`#1013`** — permanecem bloqueados até decisão explícita em contrário.
