-- Pedidos de compra marcados como cancelados pelo admin na aba Controle de Pedidos (pedido da Emilly, 14/10).
-- Tabela do portal (o Job não mexe). Uma linha por pedido cancelado; "Desfazer" apaga a linha.
-- Pedido cancelado sai das médias, do aviso "aguardando NF", do alerta "NF sem coleta" e do e-mail de cobrança.
-- Tabela pequena (só os cancelados), lida inteira a cada abertura da aba; a chave primária já é o índice.
-- Aplicar uma única vez, ANTES de publicar o código que lê esta tabela:
--   npx -y wrangler@4.147.0 d1 execute portamkt-db --remote --file d1/migracao_011_pedidos_cancelados.sql
CREATE TABLE IF NOT EXISTS pedidos_cancelados (
  pedido_compra INTEGER PRIMARY KEY, -- mesmo valor de base_geral.pedido_compra
  cancelado_por TEXT NOT NULL,       -- username do admin que marcou
  cancelado_em  TEXT NOT NULL        -- data e hora em ISO UTC
);
