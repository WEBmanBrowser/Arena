# Eupago — configuração no Backoffice

Gestão das credenciais e webhooks Eupago em **Backoffice → Definições → Eupago**
(`GET/PUT /api/admin/settings/eupago`, `POST /api/admin/settings/eupago/test`).

## Pré-requisito: chave de encriptação

Os segredos ficam guardados **encriptados (AES-256-GCM)** na tabela `settings`.
Antes de guardar o primeiro segredo no Backoffice, definir no servidor:

```bash
# 32 bytes aleatórios, em hexadecimal (64 chars)
openssl rand -hex 32
wrangler secret put SETTINGS_ENCRYPTION_KEY
```

Localmente (`.env`, nunca commitado): `SETTINGS_ENCRYPTION_KEY=<64 hex chars>`.

Sem esta chave, guardar segredos falha com `EUPAGO_ENCRYPTION_UNAVAILABLE` e
nada é escrito. **Rodar a chave invalida as linhas existentes** — ficam
ilegíveis (estado `Erro`, código `BACKOFFICE_UNREADABLE`) até serem gravadas
de novo. Isto é intencional (fail closed).

## Regra de precedência (atómica, sem misturas)

Os 5 campos nucleares — ambiente, chave de API, OAuth Client ID/Secret e chave
de webhook — formam **um bloco único**:

- **Backoffice vazio** → valem as variáveis de ambiente (`EUPAGO_*`, suporte
  total mantido; comportamento anterior inalterado).
- **Qualquer valor no Backoffice** → modo Backoffice: os 5 passam a ser
  **obrigatórios**. Bloco parcial = pagamentos Eupago indisponíveis até
  completar ou limpar. Valores do Backoffice **nunca** se misturam com ENV.

Os campos de webhook (URL do endpoint, encriptação on/off, tipos de evento)
são **informativos** — documentam o que está configurado no portal Eupago e não
alteram o runtime (o endpoint real é fixo: `/api/webhooks/eupago`; a
encriptação é auto-detetada por entrega).

## Permissões

| Operação | Nível |
|---|---|
| Ver estado (só presença/metadata, nunca segredos) | manager+ |
| Guardar / limpar / testar ligação | admin |

Mutações exigem CSRF same-origin (`csrfGuard`, padrão do projeto) e ficam em
auditoria (`eupago_config_updated`, `eupago_connection_tested`) apenas com
**nomes de campos** — nunca valores.

## Testar ligação

O botão executa **uma chamada OAuth `client_credentials`** com as credenciais
efetivas (Backoffice ou ENV). É side-effect-free: prova conetividade +
credenciais + ambiente **sem criar pagamentos**. Com config incompleta, nem a
rede é tocada. A chave de API e a chave de webhook são verificadas por
presença — não existe probe sem efeitos secundários para elas.

## Estados

- **Configurado** — conjunto completo (origem indicada: Backoffice ou ambiente).
- **Incompleto** — lista o que falta (nomes de campos ou de vars ENV).
- **Erro** — `BACKOFFICE_UNREADABLE` (chave de encriptação errada/em falta ou
  linhas adulteradas), `BACKOFFICE_INVALID` (ambiente guardado inválido),
  `ENV_INVALID` (`EUPAGO_ENVIRONMENT` inválido no servidor).
- **Aviso** `WEBHOOK_KEY_NOT_32_BYTES` — com encriptação ativa no portal, a
  chave tem de ter exatamente 32 bytes (não bloqueia; as entregas encriptadas
  é que falhariam).

## Notas de segurança

- `GET` nunca devolve segredos nem fragmentos (presence-only, decisão D4).
- Segredos colados com espaços à volta são aparados nas pontas; caracteres de
  controlo (incl. quebras de linha) são rejeitados.
- A chave de webhook **não** é gerada neste portal — é gerada no portal Eupago
  e apenas colada aqui.
- Auditoria, logs e respostas de erro nunca contêm valores de segredos.
