-- A lista de pedidos passa a ser por pedido_compra (coluna PEDIDO_COMPRA da tela): paginação, linhas
-- repetidas e busca usam pedido_compra em vez de pedido. Troca os índices de pedido pelos de pedido_compra
-- (mesma quantidade de índices, para não aumentar as gravações do Job — regra 12).
-- Aplicar uma única vez, depois da 002 e da 003, ANTES de publicar o código que usa pedido_compra:
--   npx -y wrangler@4.147.0 d1 execute portamkt-db --remote --file d1/migracao_004_indices_pedido_compra.sql
DROP INDEX IF EXISTS idx_entregas_data;
DROP INDEX IF EXISTS idx_entregas_pedido;
CREATE INDEX IF NOT EXISTS idx_entregas_data_compra ON entregas_mkt (dt_pedido DESC, pedido_compra DESC);
CREATE INDEX IF NOT EXISTS idx_entregas_compra      ON entregas_mkt (pedido_compra);
