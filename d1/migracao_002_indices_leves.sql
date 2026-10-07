-- Ajusta índices para caber no plano grátis do D1 (cada índice multiplica as gravações do Job).
-- Remove índices que nenhuma rota usa e cria o índice da ordenação da lista de pedidos.
-- Aplicar uma única vez:
--   npx wrangler d1 execute portamkt-db --remote --file d1/migracao_002_indices_leves.sql
DROP INDEX IF EXISTS idx_entregas_prazo;
DROP INDEX IF EXISTS idx_tracking_chave;
DROP INDEX IF EXISTS idx_tracking_forn;
-- idx_entregas_data (dt_pedido, pedido) foi substituído por idx_entregas_data_compra na migração 004;
-- não é criado aqui para não gastar gravações à toa (o D1 conta cada linha indexada).
