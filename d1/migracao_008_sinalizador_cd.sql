-- Sinalizador de coletas LATAM para o CD01 (08/10): aviso de coleta nova, confirmação pelo CD e coletas
-- sugeridas pela planilha CONTROLE_AÉREO. Só acrescenta colunas (a tabela continua com os dados).
-- Datas e horas em ISO UTC (ex.: 2026-10-08T15:04:05.000Z); a tela mostra no horário de Manaus.
-- Aplicar uma única vez, ANTES de publicar o código que usa estas colunas:
--   npx -y wrangler@4.147.0 d1 execute portamkt-db --remote --file d1/migracao_008_sinalizador_cd.sql
ALTER TABLE agendamentos ADD COLUMN liberado_em    TEXT;                 -- quando o admin liberou para o CD
ALTER TABLE agendamentos ADD COLUMN visto_cd_em    TEXT;                 -- quando o CD abriu a aba depois da liberação (NULL = NOVA)
ALTER TABLE agendamentos ADD COLUMN status_cd      TEXT DEFAULT 'pendente'; -- pendente | coletado | recebido
ALTER TABLE agendamentos ADD COLUMN coletado_em    TEXT;
ALTER TABLE agendamentos ADD COLUMN recebido_em    TEXT;
ALTER TABLE agendamentos ADD COLUMN confirmado_por TEXT;                 -- usuário que confirmou por último
ALTER TABLE agendamentos ADD COLUMN origem         TEXT DEFAULT 'manual'; -- manual | planilha
ALTER TABLE agendamentos ADD COLUMN ncoleta        TEXT;                 -- Nº da coleta na planilha (evita incluir duas vezes)
