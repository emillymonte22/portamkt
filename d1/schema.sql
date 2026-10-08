-- Tabelas do próprio portal.
-- senha: hash "pbkdf2$<iterações>$<sal>$<hash>"; senhas antigas em texto puro são convertidas no próximo login.
CREATE TABLE IF NOT EXISTS usuarios (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  senha    TEXT NOT NULL,
  perfil   TEXT NOT NULL -- admin | cd | comercial
);

CREATE TABLE IF NOT EXISTS agendamentos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  seller         TEXT NOT NULL,
  transportadora TEXT NOT NULL,
  nota_fiscal    TEXT NOT NULL, -- uma ou mais NFs, só números, separadas por "/"
  cte            TEXT,
  data_coleta    TEXT,
  data_cte       TEXT,
  entrega_cd     TEXT,
  status_etapa   TEXT DEFAULT 'Emissão do Pedido',
  liberado_latam INTEGER NOT NULL DEFAULT 0, -- 1 = admin liberou para o CD
  criado_em      DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- sinalizador do CD01 (migração 008); datas/horas em ISO UTC
  liberado_em    TEXT,
  visto_cd_em    TEXT,                       -- NULL = coleta liberada que o CD ainda não viu (NOVA)
  status_cd      TEXT DEFAULT 'pendente',    -- pendente | coletado | recebido
  coletado_em    TEXT,
  recebido_em    TEXT,
  confirmado_por TEXT,
  origem         TEXT DEFAULT 'manual',      -- manual | planilha
  ncoleta        TEXT                        -- Nº da coleta na planilha CONTROLE_AÉREO
);

-- Tabelas espelhadas do Databricks (preenchidas pelo Job databricks/sync_d1.py).
-- Não editar dados nestas tabelas pelo portal: o Job sobrescreve 2x por dia (8h e 12h de Manaus).
-- row_hash = sha256 da linha inteira; identifica cada linha já que a origem não tem chave única.

-- Origem: comercial.logint.f_tracking_aereo (um item de NF por linha)
CREATE TABLE IF NOT EXISTS tracking_aereo (
  row_hash             TEXT PRIMARY KEY,
  armador              TEXT,
  transportador        TEXT,
  cnpj_transportador   TEXT,
  cte                  TEXT,
  nfe_id               INTEGER,
  nota_fiscal_explode  TEXT,
  chave_cte            TEXT,
  chave_nf             TEXT,
  cfop                 TEXT,
  etapa                TEXT,
  emissao_cte          TEXT,
  emissao              TEXT,
  data_coleta          TEXT,
  data_embarque        TEXT,
  data_selagem         TEXT,
  previsao_entrega     TEXT,
  data_entrega         TEXT,
  prazo_pagamento      TEXT,
  forn                 TEXT,
  nome_forn            TEXT,
  emitente             TEXT,
  cnpj_emitente        TEXT,
  material             INTEGER,
  gm9                  INTEGER,
  descricao_material   TEXT,
  ean_mara             TEXT,
  quantidade_comercial REAL,
  cidade               TEXT,
  municipio            TEXT,
  estado               TEXT,
  valor_total_carga    REAL,
  vlr_frete            REAL,
  valor_total          REAL,
  situacao_pagamento   INTEGER,
  situacao_icms        INTEGER,
  peso_taxado          TEXT,
  volume               TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracking_nf     ON tracking_aereo (nota_fiscal_explode);

-- Origem: bemolonline.bol.dados_entregas_mkt_manifest_01 (pedido do marketplace, ponta a ponta)
CREATE TABLE IF NOT EXISTS entregas_mkt (
  row_hash                       TEXT PRIMARY KEY,
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
  data_coleta                    TEXT,
  emissao                        TEXT,
  emissao_cte                    TEXT,
  data_embarque                  TEXT,
  data_entrega                   TEXT
);
CREATE INDEX IF NOT EXISTS idx_entregas_seller ON entregas_mkt (n_fornecedor, dt_pedido);
CREATE INDEX IF NOT EXISTS idx_entregas_compra ON entregas_mkt (pedido_compra);
CREATE INDEX IF NOT EXISTS idx_entregas_ordem  ON entregas_mkt (ordem);
CREATE INDEX IF NOT EXISTS idx_entregas_nf     ON entregas_mkt (nf);
CREATE INDEX IF NOT EXISTS idx_entregas_nf_exp ON entregas_mkt (nota_fiscal_explode);
CREATE INDEX IF NOT EXISTS idx_entregas_data_compra ON entregas_mkt (dt_pedido DESC, pedido_compra DESC);

-- Origem: planilha CONTROLE_AÉREO_2026.xlsx (SharePoint), aba "Marketplace" — uma linha por NF do seller.
-- Completa o que falta em entregas_mkt (Entrega CD = agenda_cd, data_coleta, data_cte); o banco vale primeiro.
CREATE TABLE IF NOT EXISTS controle_aereo (
  row_hash            TEXT PRIMARY KEY,
  nota_fiscal_explode TEXT,
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

-- Datas do tracking_aereo por NF (maior data válida entre os itens), montada pelo Job a partir de f_tracking_aereo.
-- Completa datas vazias em entregas_mkt; ordem no portal: entregas_mkt → tracking_datas_nf → controle_aereo.
CREATE TABLE IF NOT EXISTS tracking_datas_nf (
  row_hash            TEXT PRIMARY KEY,
  nota_fiscal_explode TEXT,
  data_coleta         TEXT,
  data_embarque       TEXT,
  data_entrega        TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracking_datas_nf ON tracking_datas_nf (nota_fiscal_explode);

-- Uma linha por execução do Job, para o portal mostrar "atualizado em ..."
CREATE TABLE IF NOT EXISTS sync_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tabela       TEXT NOT NULL,
  executado_em TEXT NOT NULL,
  total_origem INTEGER,
  inseridos    INTEGER,
  removidos    INTEGER
);
