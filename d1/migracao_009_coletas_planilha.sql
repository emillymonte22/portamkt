-- Coletas da planilha CONTROLE_AÉREO_2026.xlsx, aba "Marketplace": uma linha por linha da planilha (por coleta),
-- enviada pelo Job. Alimenta "Cargas em Trânsito" (aba Consultas) e "Resumo Mensal" / "Resumo por Origem"
-- (aba Indicadores), com as mesmas regras do notebook "aereo markt" da Emilly.
-- ~460 linhas e sem índice (a tabela é lida inteira, é pequena). Não editar pelo portal: o Job sobrescreve.
-- Aplicar uma única vez, ANTES de publicar o código que lê esta tabela:
--   npx -y wrangler@4.147.0 d1 execute portamkt-db --remote --file d1/migracao_009_coletas_planilha.sql
CREATE TABLE IF NOT EXISTS coletas_planilha (
  row_hash         TEXT PRIMARY KEY,
  linha            INTEGER,  -- posição na planilha (o notebook fica com a primeira linha de cada coleta)
  ncoleta          TEXT,
  fornecedor       TEXT,
  origem           TEXT,
  destino          TEXT,
  data_coleta      TEXT,
  transportadora   TEXT,
  notas            TEXT,     -- NFs como na planilha, separadas por " / "
  cte              TEXT,
  volumes          REAL,
  peso             REAL,
  data_cte         TEXT,
  valor_nota       REAL,
  valor_frete      REAL,
  previsao_entrega TEXT,
  chegada_mao      TEXT,
  agenda_cd        TEXT,
  meta             REAL,
  lead_time        REAL,
  dias_atraso      REAL,
  status           TEXT
);
