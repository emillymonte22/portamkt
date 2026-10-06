-- Aplicar uma única vez no banco que já existia antes de d1/schema.sql:
--   npx wrangler d1 execute portamkt-db --remote --file d1/migracao_001_liberado_latam.sql
ALTER TABLE agendamentos ADD COLUMN liberado_latam INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_entregas_ordem ON entregas_mkt (ordem);
