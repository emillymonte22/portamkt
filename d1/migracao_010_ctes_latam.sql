-- CT-es emitidos pela LATAM (TAM Linhas Aéreas, CNPJ raiz 02.012.862) para os sellers do marketplace, vindos de
-- comercial.bemolcomercial.btracker_ctes pelo Job. Uma linha por CT-e, com todas as NFs dele.
-- Cada CT-e novo vira uma coleta LATAM bloqueada no portal (o admin libera); as NFs do CT-e valem sobre as da planilha
-- e a data de emissão do CT-e é a data da coleta e do embarque (decisões da Emilly em 09/10).
-- Tabela pequena (dezenas de linhas por mês), sem índice. Não editar pelo portal: o Job sobrescreve.
-- Aplicar uma única vez, ANTES de publicar o código que lê esta tabela:
--   npx -y wrangler@4.147.0 d1 execute portamkt-db --remote --file d1/migracao_010_ctes_latam.sql
CREATE TABLE IF NOT EXISTS ctes_latam (
  row_hash         TEXT PRIMARY KEY,
  cte              TEXT,     -- número do CT-e sem zeros à esquerda
  chave_cte        TEXT,
  emissao          TEXT,     -- AAAA-MM-DD (data da coleta e do embarque)
  emissao_hora     TEXT,     -- data e hora de emissão como vêm da origem
  seller           TEXT,     -- nome do seller no portal (Brascol, Vitrola, Tramontina)
  fornecedor       TEXT,     -- nome_transportador_forn da origem (ex.: ONESHOP DISTRIBUIDORA LTDA)
  emissor          TEXT,     -- ex.: TAM LINHAS AEREAS SA SAO1508
  cnpj_emissor     TEXT,
  uf_origem        TEXT,
  municipio_origem TEXT,
  notas            TEXT,     -- NFs do CT-e, "nota / nota"
  qtd_notas        INTEGER,
  valor_frete      REAL,
  valor_carga      REAL,
  situacao         INTEGER
);
