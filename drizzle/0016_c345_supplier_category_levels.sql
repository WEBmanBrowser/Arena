-- C.3.4.5 — Hierarquia de categorias ALSO (CategoryText1..3 estruturados).
--
-- IMPACTO (auditado contra a HEAD real 81b780d, migrations 0000–0015):
--  - Só 3 colunas NULLABLE novas em supplier_import_rows: zero backfill, zero
--    downtime, 100% compatível com dados e código anteriores. Linhas antigas
--    (e previews anteriores) têm as 3 a NULL = "sem informação estrutural".
--  - São a ÚNICA fonte da hierarquia no apply; supplier_category_path
--    (C.3.4.3.1) continua display/histórico apenas — nunca é splittado.
--  - 3×NULL ⇒ nenhuma categoria é criada nem ligada (produtos novos ficam com
--    categoryId NULL; produtos existentes nunca são tocados neste checkpoint).
--  - Níveis vazios são ignorados (A, NULL, C → A→C): o produto liga ao nível
--    não-vazio mais específico.
---
ALTER TABLE "supplier_import_rows" ADD COLUMN "supplier_category_text1" varchar(255);--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "supplier_category_text2" varchar(255);--> statement-breakpoint
ALTER TABLE "supplier_import_rows" ADD COLUMN "supplier_category_text3" varchar(255);