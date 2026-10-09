# Portal portamkt — instruções para o Claude Code

Todo o contexto do projeto (arquitetura, API, banco, regras obrigatórias, ferramentas e histórico) está em:

@CONTEXTO_IA.md

## Como trabalhar neste repositório

- **Antes de mexer:** `git pull`. Outras pessoas (e outras IAs) também alteram os arquivos direto no GitHub.
- **Push na `main` publica na hora** no Cloudflare. Antes do push: `node --check "functions/[[path]].js"` e teste local
  (`npx -y wrangler@4.147.0 pages dev`, seção 9 do contexto). Depois do push, confira se a publicação não deu "Failure".
- **Coluna nova no banco:** crie `d1/migracao_00X_*.sql`, aplique com wrangler `--remote` **antes** de publicar código que use a coluna,
  e atualize `d1/schema.sql` e o `CONTEXTO_IA.md`.
- **Plano grátis do D1** (regra 12): nada de `COUNT(*)`, `GROUP BY`, `LIKE '%...%'` ou consulta sem índice na tabela inteira a cada
  abertura de tela; prefira os índices existentes. Em dúvida, confira o consumo com `npx -y wrangler@4.147.0 d1 info portamkt-db`.
- **Databricks:** use o Databricks CLI com `--profile emilly` (dona do Job e com acesso às tabelas). Nunca escolha perfil sozinho
  se houver dúvida; pergunte.
- **Ao terminar uma mudança relevante**, atualize o `CONTEXTO_IA.md` (API, banco, pendências e a seção 14, Histórico) e faça
  commit junto com o código, para a próxima pessoa ou IA ter o contexto.
- **Uma vez por dia** (pedido da Emilly, 09/10): na primeira sessão do dia, e antes de encerrar o trabalho do dia, confira se
  há mudanças (na pasta, no GitHub, no banco ou no Job) que ainda não estão no `CONTEXTO_IA.md`. Se houver, registre na seção 14
  (e nas seções de API, banco e pendências) e salve no GitHub junto com os arquivos alterados. Trabalho pela metade também
  entra, marcado como "em andamento", com o que já está no ar e o que falta.
- Nunca grave senhas, tokens ou secrets no repositório.
- Escreva com o vocabulário do projeto: textos da tela em português, nomes de funções e variáveis em português, como no código atual.
