-- Planilha CONTROLE_AÉREO_2026.xlsx (SharePoint), aba "Marketplace", enviada pelo Job do Databricks.
-- Uma linha por NF do seller (a coluna NOTAS da planilha tem várias NFs separadas por "/").
-- O portal usa para completar o que falta em entregas_mkt (o banco vale primeiro):
--   Entrega CD = AGENDA CD, data da coleta e data do CT-e; e mostra os demais campos no relatório.
-- Não editar pelo portal: o Job sobrescreve 1x por dia (mesma regra de entregas_mkt).
-- Aplicar uma única vez, ANTES de publicar o código que lê esta tabela:
--   npx -y wrangler@4.147.0 d1 execute portamkt-db --remote --file d1/migracao_005_controle_aereo.sql
CREATE TABLE IF NOT EXISTS controle_aereo (
  row_hash            TEXT PRIMARY KEY,
  nota_fiscal_explode TEXT,  -- NF do seller com 10 dígitos (mesmo formato de entregas_mkt)
  ncoleta             TEXT,
  fornecedor          TEXT,
  origem              TEXT,
  destino             TEXT,
  transportadora      TEXT,
  cte                 TEXT,
  volumes             REAL,
  peso                REAL,
  valor_nota          REAL,
  valor_frete         REAL,
  data_coleta         TEXT,
  data_cte            TEXT,
  previsao_entrega    TEXT,
  chegada_mao         TEXT,
  agenda_cd           TEXT,
  meta                REAL,
  lead_time           REAL,
  dias_atraso         REAL,
  status              TEXT
);
CREATE INDEX IF NOT EXISTS idx_controle_nf ON controle_aereo (nota_fiscal_explode);
