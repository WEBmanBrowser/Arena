# S38 — Release readiness

## Confirmado no código-fonte

- Eupago: Multibanco, MB WAY e cartão; webhook HMAC; idempotência, ledger, reconciliação e reembolsos.
- WinTouch: cliente/adapter, resolução de entidade, FS/FATREC, faturação admin e pós-pagamento opcional. Falha fiscal não reverte pagamento.
- Clientes: Customer360 com encomendas, pagamentos, faturação, transporte, RMA, moradas, notas e fidelização. Cada encomenda abre agora diretamente a gestão operacional.
- Fidelização: 1 ponto por euro elegível; 100 pontos = 1 EUR; vales e utilização direta; reconciliação após pagamento/reembolso.
- ALSO: pricelist/catálogo e stock fornecedor separados do stock físico; SFTP worker read-only; sync gera preview e apply é operação separada.
- Checkout: NIF, empresa, morada de faturação/entrega, convidado, cupão, pontos/vale e métodos bank_transfer/multibanco/mbway/card.

## Bloqueadores antes de produção

1. Base de dados de produção deve ser criada/migrada de forma limpa e validada; não usar `drizzle-kit push` sobre o estado parcial anterior.
2. Confirmar secrets/bindings de produção e staging sem copiar valores entre ambientes por suposição.
3. Configurar `CRON_SECRET` e só depois ativar o cron de expiração de reservas.
4. Validar domínio `loja.mdtech.pt`/TLS antes do go-live.
5. WinTouch: validar configuração por GET/read-only antes de qualquer POST fiscal real.
6. Eupago: confirmar ambiente/credenciais/webhook de produção e URL pública do webhook.
7. ALSO: executar sync de stock em staging com o worker corrigido, rever preview e só depois aplicar; confirmar `supplier_stock` sem alterar `products.stock`.
8. Executar `node scripts/test-runner.cjs`, typecheck, Next build e OpenNext build no commit candidato.

## Deploy explícito

- `npm run deploy` e `npm run deploy:staging` publicam **staging**.
- `npm run deploy:production` é o único script de produção.
- `npm run deploy:also` publica apenas o worker ALSO SFTP.
- Existem equivalentes `dry-run:*` para validação sem publicação.
