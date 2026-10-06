-- Coletas LATAM: agendamentos passa a guardar CT-e, datas de coleta/CT-e/entrega no CD
-- e várias NFs separadas por "/". Motorista, placa, tipo de carga e data de agendamento
-- deixam de existir (não são usados). O SQLite não altera colunas: recria a tabela copiando os dados.
-- Aplicar uma única vez:
--   npx wrangler d1 execute portamkt-db --remote --file d1/migracao_003_coletas_latam.sql
CREATE TABLE agendamentos_nova (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  seller         TEXT NOT NULL,
  transportadora TEXT NOT NULL,
  nota_fiscal    TEXT NOT NULL, -- uma ou mais NFs, só números, separadas por "/"
  cte            TEXT,
  data_coleta    TEXT,
  data_cte       TEXT,
  entrega_cd     TEXT,
  status_etapa   TEXT DEFAULT 'Emissão do Pedido',
  liberado_latam INTEGER NOT NULL DEFAULT 0,
  criado_em      DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO agendamentos_nova (id, seller, transportadora, nota_fiscal, status_etapa, liberado_latam, criado_em)
SELECT id, seller, transportadora, nota_fiscal, status_etapa, liberado_latam, criado_em FROM agendamentos;

DROP TABLE agendamentos;
ALTER TABLE agendamentos_nova RENAME TO agendamentos;
