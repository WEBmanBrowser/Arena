ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "terms_accepted_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "terms_version" varchar(50);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privacy_acknowledged_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privacy_version" varchar(50);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "marketing_consent_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "marketing_consent_version" varchar(50);
INSERT INTO "pages" ("title", "slug", "content", "is_published", "created_at", "updated_at") VALUES ('Política de Privacidade','politica-privacidade','Política de Privacidade

Responsável pelo tratamento
Marco Duarte Tech Solutions Unipessoal Lda (nome comercial: MDTech), NIPC 519 445 902, com sede na Rua Sargento Álvaro Fernandes, n.º 7, 2.º B, 4740-567 Esposende. Contacto: geral@mdtech.pt.

Finalidades e fundamentos
Tratamos os dados necessários à criação e gestão da conta, processamento de encomendas, pagamentos, faturação, entrega, assistência pós-venda, garantias e cumprimento de obrigações legais. Estes tratamentos podem basear-se na execução do contrato, diligências pré-contratuais, cumprimento de obrigações legais e, quando aplicável, interesses legítimos. Comunicações de marketing baseadas em consentimento são facultativas e independentes da criação de conta ou compra.

Destinatários
Os dados podem ser comunicados a prestadores necessários à execução dos serviços, designadamente pagamentos, faturação, transporte, alojamento/infraestrutura e comunicações, limitados ao necessário e sujeitos às garantias aplicáveis.

Conservação
Os dados são conservados apenas durante os períodos necessários às finalidades indicadas e aos prazos legais aplicáveis, incluindo obrigações fiscais e contabilísticas.

Direitos
Nos termos do RGPD, pode solicitar, quando aplicável, acesso, retificação, apagamento, limitação, portabilidade e oposição, bem como retirar consentimentos sem afetar a licitude do tratamento anterior. Pode ainda apresentar reclamação à Comissão Nacional de Proteção de Dados (CNPD).

Segurança
A MDTech aplica medidas técnicas e organizativas adequadas à proteção dos dados pessoais.

Última atualização: 22 de setembro de 2026.',true,now(),now()) ON CONFLICT ("slug") DO UPDATE SET "title"=EXCLUDED."title", "content"=EXCLUDED."content", "is_published"=true, "updated_at"=now();
INSERT INTO "pages" ("title", "slug", "content", "is_published", "created_at", "updated_at") VALUES ('Termos e Condições','termos-condicoes','Termos e Condições

1. Identificação
A loja MDTech é explorada por Marco Duarte Tech Solutions Unipessoal Lda, NIPC 519 445 902, Rua Sargento Álvaro Fernandes, n.º 7, 2.º B, 4740-567 Esposende. Contacto: geral@mdtech.pt.

2. Âmbito
Os presentes termos regulam a utilização da loja online e os contratos de compra celebrados através da mesma. Antes de concluir a encomenda, o cliente tem oportunidade de rever os artigos, preços, impostos, entrega e método de pagamento.

3. Preços e pagamento
Os preços apresentados ao consumidor incluem IVA à taxa legal em vigor, salvo indicação legalmente admissível em contrário. O total e os custos de entrega aplicáveis são apresentados antes da conclusão da encomenda. Os meios de pagamento disponíveis são os apresentados no checkout.

4. Encomenda e confirmação
A encomenda é submetida através do botão que indica expressamente a obrigação de pagamento. A receção eletrónica da encomenda não prejudica validações de pagamento, disponibilidade e mecanismos legalmente admissíveis de prevenção de erro ou fraude.

5. Entrega
Os métodos, custos e estimativas de entrega aplicáveis são apresentados durante a compra. O cliente deve fornecer dados corretos e completos.

6. Livre resolução
Quando o comprador seja consumidor e o contrato esteja abrangido pelo regime de contratos celebrados à distância, pode exercer o direito de livre resolução no prazo legal de 14 dias, sem necessidade de indicar motivo, ressalvadas as exceções previstas na lei. Consulte a Política de Devoluções para instruções.

7. Conformidade e garantias
Os direitos legais do consumidor relativos à conformidade dos bens não são limitados por garantias comerciais ou do fabricante. Consulte a página Garantias.

8. Reclamações e RAL
O consumidor pode utilizar o Livro de Reclamações Eletrónico. Para resolução alternativa de litígios de consumo, consulte a página Resolução de Litígios, incluindo os dados do CIAB.

9. Dados pessoais e cookies
O tratamento de dados pessoais é explicado na Política de Privacidade e a utilização de cookies na Política de Cookies.

10. Lei aplicável
Aplicam-se as normas imperativas portuguesas e da União Europeia relevantes, sem prejuízo dos direitos do consumidor que não possam ser contratualmente afastados.

Última atualização: 22 de setembro de 2026.',true,now(),now()) ON CONFLICT ("slug") DO UPDATE SET "title"=EXCLUDED."title", "content"=EXCLUDED."content", "is_published"=true, "updated_at"=now();
INSERT INTO "pages" ("title", "slug", "content", "is_published", "created_at", "updated_at") VALUES ('Política de Cookies','politica-cookies','Política de Cookies

A MDTech utiliza cookies e tecnologias semelhantes estritamente necessários ao funcionamento e segurança da loja, incluindo autenticação e manutenção de funcionalidades solicitadas pelo utilizador.

Cookies não essenciais, incluindo analítica ou marketing, não devem ser ativados antes da escolha do utilizador quando seja exigido consentimento. O utilizador pode aceitar todos ou rejeitar os não essenciais através do aviso apresentado no site.

A configuração concreta de ferramentas de analítica/marketing deve ser refletida nesta política antes da sua ativação em produção, incluindo finalidade, fornecedor e duração.

A eliminação de cookies no navegador não substitui necessariamente a gestão das preferências no site.

Última atualização: 22 de setembro de 2026.',true,now(),now()) ON CONFLICT ("slug") DO UPDATE SET "title"=EXCLUDED."title", "content"=EXCLUDED."content", "is_published"=true, "updated_at"=now();
INSERT INTO "pages" ("title", "slug", "content", "is_published", "created_at", "updated_at") VALUES ('Política de Devoluções','politica-devolucoes','Devoluções e Livre Resolução

Consumidores que celebrem contratos à distância dispõem, em regra, de 14 dias para exercer o direito de livre resolução, sem necessidade de indicar motivo, nos termos e com as exceções previstas no Decreto-Lei n.º 24/2014.

Para exercer o direito, comunique de forma inequívoca a decisão à MDTech dentro do prazo legal, identificando a encomenda e os artigos. Pode utilizar a área de cliente/RMA ou contactar geral@mdtech.pt.

Após a comunicação, os bens devem ser devolvidos dentro do prazo legal aplicável. O consumidor pode ser responsável pela depreciação resultante de manipulações que excedam o necessário para verificar a natureza, características e funcionamento do bem.

Existem exceções legais ao direito de livre resolução, pelo que a elegibilidade deve ser analisada de acordo com o produto/serviço e as circunstâncias concretas.

Uma devolução por livre resolução não se confunde com um pedido por falta de conformidade/garantia.

Última atualização: 22 de setembro de 2026.',true,now(),now()) ON CONFLICT ("slug") DO UPDATE SET "title"=EXCLUDED."title", "content"=EXCLUDED."content", "is_published"=true, "updated_at"=now();
INSERT INTO "pages" ("title", "slug", "content", "is_published", "created_at", "updated_at") VALUES ('Garantias','garantias','Garantias e Conformidade

Os consumidores beneficiam dos direitos legais relativos à conformidade dos bens previstos no Decreto-Lei n.º 84/2021. Para bens móveis novos, a responsabilidade do profissional por falta de conformidade manifestada é, em regra, de três anos a contar da entrega, sem prejuízo das regras específicas, exceções e demais direitos previstos na lei.

Consoante os requisitos legais estejam preenchidos, os meios de reposição da conformidade podem incluir reparação ou substituição e, nas situações legalmente previstas, redução proporcional do preço ou resolução do contrato.

Uma garantia comercial ou garantia do fabricante é adicional e não reduz os direitos legais do consumidor.

Os pedidos podem ser iniciados na área de cliente em RMA / Assistência, indicando a encomenda, artigo e descrição do problema.

Última atualização: 22 de setembro de 2026.',true,now(),now()) ON CONFLICT ("slug") DO UPDATE SET "title"=EXCLUDED."title", "content"=EXCLUDED."content", "is_published"=true, "updated_at"=now();
INSERT INTO "pages" ("title", "slug", "content", "is_published", "created_at", "updated_at") VALUES ('Resolução de Litígios','resolucao-litigios','Resolução de Litígios de Consumo

Em caso de litígio de consumo, o consumidor pode recorrer a uma entidade de resolução alternativa de litígios de consumo.

CIAB — Tribunal Arbitral de Consumo
Rua D. Afonso Henriques, 1
4700-030 Braga
Website: https://ciab.pt/

Livro de Reclamações Eletrónico
https://www.livroreclamacoes.pt/inicio/

A antiga Plataforma Europeia de Resolução de Litígios em Linha (ODR/RLL) foi descontinuada e o Regulamento (UE) n.º 524/2013 foi revogado com efeitos a 20 de julho de 2025; por esse motivo, a MDTech não apresenta um link para a antiga plataforma.

Última atualização: 22 de setembro de 2026.',true,now(),now()) ON CONFLICT ("slug") DO UPDATE SET "title"=EXCLUDED."title", "content"=EXCLUDED."content", "is_published"=true, "updated_at"=now();
INSERT INTO "settings" ("key","value","group") VALUES ('company_name','Marco Duarte Tech Solutions Unipessoal Lda','general') ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value";
INSERT INTO "settings" ("key","value","group") VALUES ('company_address','Rua Sargento Álvaro Fernandes, n.º 7, 2.º B, 4740-567 Esposende','general') ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value";
INSERT INTO "settings" ("key","value","group") VALUES ('company_nif','519445902','general') ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value";
