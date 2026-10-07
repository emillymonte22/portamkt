-- Base geral: uma linha por linha do manifest da BOL (entregas_mkt), já unificada pelo Job do Databricks com
-- as 3 bases, pela NF do seller: manifest da BOL → tracking aéreo → planilha CONTROLE_AÉREO (aba Marketplace).
-- Datas vazias são completadas nessa ordem; CT-e e transportadora vêm do tracking e, se faltar, da planilha.
-- O portal passa a ler só esta tabela (lista, indicadores, lead time, relatório) quando o Job registrar a
-- primeira carga em sync_log; até lá continua em entregas_mkt.
-- Índices enxutos (regra 12): cada índice multiplica as gravações do Job. A 1ª carga grava ~18 mil linhas x 4.
-- Aplicar uma única vez:
--   npx -y wrangler@4.147.0 d1 execute portamkt-db --remote --file d1/migracao_007_base_geral.sql
CREATE TABLE IF NOT EXISTS base_geral (
  row_hash                       TEXT PRIMARY KEY,
  -- manifest da BOL (mesmas colunas de entregas_mkt)
  pedido_compra                  INTEGER,
  centro                         TEXT,
  pedido                         INTEGER,
  ordem                          INTEGER,
  nf                             INTEGER,
  fornecedor                     INTEGER,
  n_fornecedor                   TEXT,
  dt_pedido                      TEXT,
  dt_liberacao                   TEXT,
  dt_faturamento                 TEXT,
  dt_entrega                     TEXT,
  no_prazo                       TEXT,
  centro_expedicao               TEXT,
  cidade                         TEXT,
  bairro                         TEXT,
  zona                           TEXT,
  uf                             TEXT,
  documento_compras              TEXT,
  numero_documento_nove_posicoes TEXT,
  origem                         TEXT,
  nome_forn                      TEXT,
  nota_fiscal_explode            TEXT,
  emissao                        TEXT,
  -- datas unificadas (manifest → tracking → planilha)
  data_coleta                    TEXT,
  emissao_cte                    TEXT,
  data_embarque                  TEXT,
  data_entrega                   TEXT,  -- Entrega CD
  fonte_entrega_cd               TEXT,  -- manifest | tracking | planilha
  -- transporte unificado (tracking → planilha)
  transportadora                 TEXT,  -- várias separadas por ", "
  cte                            TEXT,  -- vários separados por ", "
  transportes                    TEXT,  -- pares "transportadora␟cte" separados por "," (tracking + planilha), para as regras do relatório
  -- planilha CONTROLE_AÉREO (volumes, peso e valores são da coleta inteira)
  pl_ncoleta                     TEXT,
  pl_transportadora              TEXT,
  pl_cte                         TEXT,
  pl_origem                      TEXT,
  pl_destino                     TEXT,
  pl_volumes                     REAL,
  pl_peso                        REAL,
  pl_valor_nota                  REAL,
  pl_valor_frete                 REAL,
  pl_data_coleta                 TEXT,
  pl_data_cte                    TEXT,
  pl_previsao_entrega            TEXT,
  pl_chegada_mao                 TEXT,
  pl_agenda_cd                   TEXT,
  pl_meta                        REAL,
  pl_lead_time                   REAL,
  pl_dias_atraso                 REAL,
  pl_status                      TEXT
);
CREATE INDEX IF NOT EXISTS idx_base_data_compra ON base_geral (dt_pedido DESC, pedido_compra DESC);
CREATE INDEX IF NOT EXISTS idx_base_compra      ON base_geral (pedido_compra);
CREATE INDEX IF NOT EXISTS idx_base_nf_exp      ON base_geral (nota_fiscal_explode);
