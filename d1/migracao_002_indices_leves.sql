-- Ajusta índices para caber no plano grátis do D1 (cada índice multiplica as gravações do Job).
-- Remove índices que nenhuma rota usa e cria o índice da ordenação da lista de pedidos.
-- Aplicar uma única vez:
--   npx wrangler d1 execute portamkt-db --remote --file d1/migracao_002_indices_leves.sql
DROP INDEX IF EXISTS idx_entregas_prazo;
DROP INDEX IF EXISTS idx_tracking_chave;
DROP INDEX IF EXISTS idx_tracking_forn;
CREATE INDEX IF NOT EXISTS idx_entregas_data ON entregas_mkt (dt_pedido DESC, pedido DESC);
