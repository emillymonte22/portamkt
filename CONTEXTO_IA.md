# Contexto do projeto para IAs (ChatGPT, Gemini, Copilot, Claude…)

> **Como usar:**
> - **Claude Code:** abra o Claude na pasta do projeto clonado do GitHub. Ele lê o `CLAUDE.md` sozinho, que carrega este arquivo.
> - **IA de chat (Gemini, ChatGPT…):** cole este arquivo inteiro no início da conversa e, junto, o arquivo que vai mudar
>   (normalmente `public/index.html`). Peça o arquivo **completo** de volta e confira se ele termina certo antes de colar no GitHub.
> - Em qualquer caso, respeite as "Regras obrigatórias" (seção 8). O histórico do que já foi feito está na seção 14.

## 1. O que é

**Portal Logístico — Bemol Marketplace** (`portamkt`). Portal interno da Bemol, usado só por funcionários,
para acompanhar pedidos do marketplace do fornecedor (seller) até a entrega ao cliente, e gerir agendamentos
de cargas para o CD de Manaus.

- Endereço: https://portamkt.pages.dev
- Repositório: https://github.com/emillymonte22/portamkt
- Idioma da interface: português.

## 2. Arquitetura

```
Databricks (2 tabelas)
   │  Job "portamkt - sync Databricks -> D1" (1 vez por dia, às 8h, fuso America/Manaus)
   ▼
Cloudflare D1 (banco SQLite "portamkt-db")
   ▲
   │  Cloudflare Pages Functions  →  functions/[[path]].js   (API /api/*)
   │
Cloudflare Pages (site estático)  →  public/index.html      (tela)
```

- **Hospedagem:** Cloudflare Pages, ligado ao GitHub. **Todo push na branch `main` publica automaticamente** em 1–2 minutos.
- **Front-end:** um único arquivo `public/index.html` com HTML + Tailwind (via CDN) + JavaScript puro. Sem framework, sem build.
- **Back-end:** `functions/[[path]].js` (Cloudflare Pages Functions, JavaScript, roda no Workers). Atende tudo que começa com `/api/`.
- **Banco:** Cloudflare D1 (SQLite), acessado no código por `env.DB`.

## 3. Arquivos

| Arquivo | O que é |
|---|---|
| `public/index.html` | A tela inteira (login, menu lateral, abas, tabelas). **É aqui que se ajusta a interface.** |
| `functions/[[path]].js` | A API: login, sessão, permissões e consultas ao banco. |
| `wrangler.toml` | Configuração do Cloudflare (nome do projeto, pasta `public`, ligação com o D1). Não mexer sem necessidade. |
| `d1/schema.sql` | Estrutura de todas as tabelas do banco. |
| `d1/migracao_*.sql` | Alterações de banco, em ordem. Ver na seção 11 quais ainda faltam aplicar. |
| `databricks/sync_d1.py` | Notebook do Job que copia os dados do Databricks para o D1. |
| `databricks/job.json` | Configuração do Job no Databricks (cluster, horário, e-mails). |
| `CONTEXTO_IA.md` | Este arquivo. |
| `CLAUDE.md` | Instruções para o Claude Code (carrega este arquivo automaticamente). |
| `ferramentas/trocar_senha.ps1` | Gera o comando SQL para trocar senha/login de um usuário, com a senha já em hash (seção 13). |

Arquivos fora de `public/` **não** ficam acessíveis pela internet.

## 4. Perfis de usuário

Login com usuário e senha (tabela `usuarios`). Três perfis:

| Perfil | Vê | Pode |
|---|---|---|
| `comercial` | Consultas, Indicadores, Relatórios | Só consultar |
| `cd` | Consultas (só "Pedidos Marketplace", **sem** o cartão "Inclusão de Coletas (LATAM)"), Indicadores, Relatórios + "Disponível para Coleta (LATAM)" | Só consultar |
| `admin` | Tudo + "Painel Admin (Sinalização)" | **Incluir coletas LATAM** e liberar/bloquear cargas para o CD |

## 5. Autenticação e segurança (como funciona)

- `POST /api/login` confere a senha e devolve um **cookie `sessao`** (HttpOnly, Secure, SameSite=Strict) assinado com HMAC-SHA256 usando o secret `SESSION_SECRET` (configurado no Cloudflare, **nunca** no código). Validade: 8 horas.
- A cada requisição a API confere o usuário na tabela `usuarios` (1 linha lida): **usuário apagado, perfil alterado ou senha trocada valem na hora**. O cookie leva uma marca da senha gravada (`ver`); se a senha mudar no banco, as sessões abertas caem e a pessoa precisa entrar com a senha nova.
- Senhas guardadas como hash `pbkdf2$<iterações>$<sal>$<hash>`. Senha antiga em texto puro é convertida automaticamente no próximo login.
- **Toda rota `/api/*` exige sessão**, exceto `/api/login`. Sem sessão → 401 e a tela volta para o login.
- **Permissões são checadas no servidor** (`functions/[[path]].js`). A tela só esconde menus; quem garante é a API.
- Requisições `POST`/`PATCH` precisam de `Content-Type: application/json`.

## 6. API (functions/[[path]].js)

| Método e rota | Perfil | Retorno |
|---|---|---|
| `POST /api/login` `{username, senha}` | público | `{username, perfil}` + cookie |
| `POST /api/logout` | qualquer | apaga o cookie |
| `GET /api/me` | logado | `{username, perfil}` |
| `GET /api/agendamentos` | comercial, admin | últimos 100 agendamentos (cartão "Inclusão de Coletas" da aba Consultas; o CD recebe 403) |
| `GET /api/agendamentos?escopo=cd` | cd, admin | **todas** as coletas LATAM liberadas (aba "Disponível para Coleta"; recarrega ao abrir a aba) |
| `GET /api/agendamentos?escopo=admin` | admin | todas as coletas LATAM, bloqueadas primeiro (Painel Admin; recarrega ao abrir a aba) |
| `POST /api/agendamentos` `{seller, transportadora, nota_fiscal, cte, data_coleta, data_cte, entrega_cd, status_etapa}` | admin | inclui coleta LATAM. `nota_fiscal` aceita várias NFs separadas por `/`. **Nasce bloqueada** (`liberado_latam = 0`) |
| `PATCH /api/agendamentos/:id/latam` `{liberado_latam: true/false}` | admin | libera (avisa o CD) ou bloqueia a coleta |
| `GET /api/entregas?seller=&status=&de=&ate=&busca=&apos_data=&apos_pedido_compra=` | logado | `{itens, tem_mais, proximo, por_pagina}` (50 pedidos de compra por página, sem repetir `pedido_compra`; linhas sem `pedido_compra` não aparecem). Paginação por **cursor**: para a próxima página, envie `apos_data`/`apos_pedido_compra` de `proximo`. Sem data, mostra o ano corrente. `busca`: número exato de NF, pedido de compra (`pedido_compra`) ou ordem em todo o histórico; se não achar, busca "contém" no ano. **Não retorna total** (ver regra 12) |
| `GET /api/entregas/filtros` | logado | `{sellers: [...], status: [...]}` para preencher os selects |
| `GET /api/indicadores?seller=&de=&ate=` | logado | `{de, ate, seller, grupos}`: um grupo por seller × mês (`mes` = `AAAA-MM`) com `pedidos`, `no_prazo`, `fora_prazo`, `sem_entrega` e somas/quantidades de dias (`soma_fat/n_fat` pedido→faturamento CD, `soma_ent/n_ent` pedido→entrega cliente, `soma_cd/n_cd` coleta→entrega CD). Sem data, ano corrente. Cada `pedido` conta uma vez. Uma consulta por filtro, em cache por 30 min; a tela soma os grupos |
| `GET /api/relatorio?de=&ate=&seller=&transportadora=&apos_id=` | logado | `{itens, proximo}`: partes de 1.000 linhas de `entregas_mkt` (todas as colunas + `transportador` e `cte` do tracking pela NF, vários separados por vírgula). **Só as combinações de `REGRAS_RELATORIO`**: GRU - KM CARGO só Brascol, LLS só Vitrola e Tramontina, LATAM (ainda sem dados no tracking). `transportadora` = `GRU`, `LLS`, `LATAM` ou vazio (todas as regras). Cursor = `rowid` (`_id`); peça a próxima parte com `apos_id=proximo` até vir `null`. Sem data, ano corrente |
| `GET /api/relatorio/filtros` | logado | `{transportadoras: [{valor, rotulo}]}` = `REGRAS_RELATORIO` (não lê o banco) |
| `GET /api/tracking?nf=` | logado | itens da NF na tabela de tracking aéreo |
| `GET /api/sync-status` | logado | data/hora da última sincronização com o Databricks |

No front, todas as chamadas passam pela função `api(caminho, opcoes)` em `public/index.html`, que já trata 401 e erros.

## 7. Banco de dados (D1)

**Tabelas do portal** (editadas pelo portal):
- `usuarios` — `id, username, senha (hash), perfil`
- `agendamentos` (coletas LATAM) — `id, seller, transportadora, nota_fiscal (uma ou mais NFs só com números, separadas por "/", ex.: 617944/617945), cte, data_coleta, data_cte, entrega_cd, status_etapa, liberado_latam (0 = bloqueada, 1 = liberada para o CD), criado_em`. Só o admin inclui; a coleta nasce bloqueada e o admin libera no Painel Admin.

**Tabelas espelhadas do Databricks** (somente leitura para o portal; o Job apaga/insere 1x por dia, às 8h de Manaus — **não editar à mão nem pelo portal**):
- `entregas_mkt` ← `bemolonline.bol.dados_entregas_mkt_manifest_01`. Um pedido do marketplace por linha. Colunas principais: `pedido, ordem, nf, n_fornecedor (seller), dt_pedido, dt_liberacao, dt_faturamento, dt_entrega, no_prazo (NO PRAZO | SEM ENTREGA | FORA DO PRAZO), cidade, bairro, zona, uf, nota_fiscal_explode, data_coleta, emissao_cte, data_embarque, data_entrega`.
- `tracking_aereo` ← `comercial.logint.f_tracking_aereo`. Um item de NF por linha, com CT-e, transportadora, datas de coleta/embarque/entrega, material e valores. A coluna `etapa` vem em código do sistema (`MANIFEST_01`, `VLPOSTNG_01`, `SCHEDULE_01`…), ainda sem tradução.
- `sync_log` — uma linha por execução do Job (`tabela, executado_em, total_origem, inseridos, removidos`).
- **Onde está cada campo** (não confundir): `dt_faturamento`, `dt_entrega` e `no_prazo` só existem em `entregas_mkt`; `data_coleta`, `emissao_cte`, `data_embarque`, `data_entrega` (entrega no CD) e `emissao` estão em `tracking_aereo`; `liberado_latam`, `cte`, `entrega_cd` e `status_etapa` só em `agendamentos`.
- Ligação entre as duas: `entregas_mkt.nota_fiscal_explode = tracking_aereo.nota_fiscal_explode` (texto com 10 dígitos e zeros à esquerda, ex.: `0000616662`).
- Todas as datas são texto `AAAA-MM-DD`.

## 8. Regras obrigatórias para qualquer alteração

1. **Nunca colocar texto vindo do banco direto no HTML.** Ao montar HTML com template string, use sempre `esc(valor)`. Para preencher um elemento com texto, use `elemento.textContent = ...`. (Evita XSS.)
2. **Datas:** use `formatarData(valor)` para mostrar `AAAA-MM-DD` como `DD/MM/AAAA`. **Não** use `new Date('2026-10-06')` para datas, porque em Manaus (UTC-4) aparece o dia anterior.
3. **Nunca mostrar dado inventado.** Campo vazio aparece como `—`. Não usar datas ou status "de exemplo".
4. **Não usar `localStorage` para login ou perfil.** Quem está logado vem de `GET /api/me`.
5. **Nova rota na API:** criar em `functions/[[path]].js`, depois do trecho que lê a sessão (`lerSessao`), e checar `usuario.perfil` quando a ação for restrita. Usar sempre `env.DB.prepare('... ? ...').bind(valor)` — **nunca** montar SQL juntando texto com valores do usuário.
6. **Novo menu/aba:** adicionar o botão `id="menu-<nome>"`, o conteúdo `id="conteudo-<nome>"` e a entrada no objeto `MENUS` em `public/index.html` (o `mudarAba` usa esse objeto para destacar o menu certo).
7. **Não colocar senhas, tokens ou secrets em nenhum arquivo** do repositório.
8. **Não alterar as tabelas `entregas_mkt`, `tracking_aereo` e `sync_log` pelo portal** — elas são sobrescritas pelo Job.
9. **Coluna nova no banco exige migração ANTES de usar no código.** Se a API passar a gravar/ler uma coluna que não existe, dá "Erro interno". Mudança de estrutura no banco: criar um arquivo novo `d1/migracao_00X_<descricao>.sql`, aplicar com o comando da seção 9 e atualizar `d1/schema.sql`.
10. Manter o visual: Tailwind, azul Bemol `#003366` / `#002B49`, cartões `bg-white rounded-2xl shadow-sm border border-slate-200`.
11. Só o admin inclui coletas LATAM.
12. **Limites do plano grátis do D1:** 5 milhões de linhas lidas e 100 mil gravadas por dia. Não usar `COUNT(*)` nem consultas sem `WHERE`/`LIMIT` na tabela inteira a cada abertura de tela; não criar índices sem necessidade (cada índice multiplica as gravações do Job).

## 9. Como publicar e testar

- **Publicar:** commit + push na `main` → o Cloudflare publica sozinho. Acompanhar em dash.cloudflare.com → Workers & Pages → portamkt.
- **Testar no computador** (precisa de Node.js). Use a versão fixa `wrangler@4.147.0`: no Windows, o `npx` às vezes trava (erro `EBUSY`) ao baixar versão nova.
  ```
  npx -y wrangler@4.147.0 login
  npx -y wrangler@4.147.0 d1 execute portamkt-db --local --file d1/schema.sql
  echo SESSION_SECRET=qualquer-texto-longo-para-teste > .dev.vars
  npx -y wrangler@4.147.0 pages dev
  ```
  Abre em http://localhost:8788 com um banco local vazio (crie usuários de teste com `npx wrangler d1 execute portamkt-db --local --command "INSERT INTO usuarios ..."`; senha em texto puro vira hash no primeiro login).
- **Aplicar migração no banco real:** `npx -y wrangler@4.147.0 d1 execute portamkt-db --remote --file d1/migracao_00X_....sql`
- **Ver consumo do D1** (limites da regra 12): `npx -y wrangler@4.147.0 d1 info portamkt-db` (`rows_read_24h`, `rows_written_24h`).
- **Ver se a publicação deu certo:** `npx -y wrangler@4.147.0 pages deployment list --project-name portamkt --environment production` ("Failure" = o site antigo continua no ar).

## 10. Job do Databricks

- Nome: `portamkt - sync Databricks -> D1` (ID `1025737974527673`), notebook em `/Users/emillymonte@bemol.com.br/portamkt/sync_d1`.
- Roda no cluster compartilhado **DATA-COMERCIAL-01**, 1 vez por dia, às 8h (as tabelas de origem só mudam 1x por dia). Falhas mandam e-mail.
- Lê as duas tabelas sem linhas repetidas, calcula um hash por linha e só envia ao D1 o que mudou (insere novas, apaga as que sumiram). Tem trava: se a origem vier com menos da metade das linhas, aborta sem apagar nada.
- Usa o secret `portamkt/cloudflare_token` do Databricks (API Token do Cloudflare com permissão D1:Edit).
- A Emilly **não tem permissão de computação serverless** no workspace; por isso o Job usa o cluster DATA-COMERCIAL-01 (`0811-172632-o2hyyoxq`, desliga após 10 min parado). Existe também a política de cluster "comercial" (`001D0520A2F3F477`, para Jobs) como alternativa.
- Alterou `databricks/sync_d1.py`? É preciso reenviar o notebook ao Databricks:
  `databricks workspace import /Users/emillymonte@bemol.com.br/portamkt/sync_d1 --file databricks/sync_d1.py --language PYTHON --format SOURCE --overwrite --profile emilly`
  (no Git Bash do Windows, antes rode `export MSYS_NO_PATHCONV=1`, senão o caminho `/Users/...` vira caminho do Windows).
- Comandos úteis (Databricks CLI, perfil `emilly`):
  ```
  databricks jobs list-runs --job-id 1025737974527673 --limit 5 --profile emilly    # últimas execuções
  databricks jobs get-run <run_id> --profile emilly                                   # status de uma execução
  databricks jobs get-run-output <task_run_id> --profile emilly                       # erro de uma execução
  databricks jobs run-now 1025737974527673 --profile emilly --no-wait                 # rodar agora
  databricks jobs get 1025737974527673 --profile emilly                               # configuração/agendamento
  databricks jobs update --json @arquivo.json --profile emilly                        # mudar agendamento (job_id + new_settings)
  ```

## 11. Pendências conhecidas

- Compartilhar o Job e a pasta do notebook com `carlossimoes@bemol.com.br` (Can Manage): a Emilly faz pela interface do Databricks (Permissions).
- Traduzir os códigos da coluna `etapa` (`MANIFEST_01`, `VLPOSTNG_01`, …) para nomes legíveis.
- Detalhe do tracking por NF (`/api/tracking`) já existe na API, mas ainda não tem tela.
- O formulário "Nova Coleta LATAM" tem lista fixa de sellers no HTML.
- Limitar tentativas de login (regra de rate limiting no Cloudflare).
- Trocar o dono do Job por um usuário de serviço (service principal) em vez de uma pessoa.
- Futuro: possível migração para a workstation NVIDIA do setor (via Cloudflare Tunnel ou só na rede interna).
- Ideias para facilitar as alterações: separar o JavaScript de `public/index.html` em `public/app.js` (arquivo menor, a IA não corta); checagem automática no GitHub (GitHub Actions) para barrar arquivo cortado, coluna inexistente e remoção de `esc()`; trabalhar em branch com link de preview do Cloudflare antes de juntar na `main`.
- Login por SSO da Bemol (Cloudflare Access + Entra ID) quando a TI liberar; até lá, usuário e senha.

## 12. Ferramentas e acessos

**Databricks CLI** (`databricks`, versão 1.0 ou mais nova). Workspace: `https://bemol.azuredatabricks.net` (workspace id `926216925051160`).
- Perfis no `~/.databrickscfg` de quem usa: `bemol` (Carlos, `carlossimoes@bemol.com.br`) e `emilly` (Emilly, `emillymonte@bemol.com.br`).
  Criar/renovar login: `databricks auth login --host https://bemol.azuredatabricks.net --profile <nome> --workspace-id 926216925051160`.
- Só a Emilly tem acesso às duas tabelas de origem (o Carlos não tem `USE CATALOG` em `bemolonline`); por isso o Job e o notebook são dela.
- Explorar tabelas: `databricks experimental aitools tools discover-schema <catalogo.schema.tabela> --profile emilly` e
  `databricks experimental aitools tools query "SELECT ..." --profile emilly`. A view `dados_entregas_mkt_manifest_01` é lenta (minutos) e tem ~93% de linhas duplicadas (246 mil linhas, ~17,8 mil distintas).
- Secret do Job: escopo `portamkt`, chave `cloudflare_token` (`databricks secrets list-secrets portamkt --profile emilly` mostra só o nome).

**Cloudflare** (conta `4746b3c1373994e7d5599eb813e754fc`): projeto Pages `portamkt`, banco D1 `portamkt-db` (`46af9aee-add1-421f-90c6-a87f847fca86`).
- CLI `wrangler`: use `npx -y wrangler@4.147.0 ...` (login com `npx -y wrangler@4.147.0 login`).
- Secret do site: `SESSION_SECRET`, guardado só no Cloudflare (`wrangler pages secret put SESSION_SECRET --project-name portamkt`). Trocar o valor desloga todo mundo.
- Plano **gratuito** (decisão: caber no grátis em vez de pagar US$ 5/mês do Workers Paid). Limites na regra 12.

**GitHub:** `emillymonte22/portamkt`, branch `main` publica direto.

## 13. Usuários do portal

Tabela `usuarios` (admin, cd, comercial: um de cada hoje). Para criar um usuário, insira a senha em texto puro; ela vira hash no primeiro login:
`npx -y wrangler@4.147.0 d1 execute portamkt-db --remote --command "INSERT INTO usuarios (username, senha, perfil) VALUES ('nome', 'senha-inicial', 'cd')"`

Para **trocar a senha** (e, se quiser, o login) de alguém, use o script que gera o comando com a senha **já em hash** (a senha é digitada escondida e nunca fica em texto puro; exige 12+ caracteres com 3 tipos):
`powershell -ExecutionPolicy Bypass -File ferramentas\trocar_senha.ps1 -Usuario <login-atual> [-NovoUsuario <novo-login>]`
O comando sai copiado; cole e execute em dash.cloudflare.com → D1 → `portamkt-db` → Console (ou com `wrangler d1 execute --remote --command`). Com o código atual, as sessões abertas com a senha antiga caem na hora. Para derrubar **todas** as sessões de uma vez, troque o `SESSION_SECRET` (seção 12).

## 14. Histórico e decisões (out/2026)

Em ordem, para quem pegar o projeto entender por que as coisas são como são:

1. **Análise inicial (06/10):** a primeira versão tinha login só na tela (bastava editar o `localStorage` para virar admin), API aberta, senhas em texto puro, XSS, datas inventadas, rota de liberação LATAM inexistente e backend duplicado (`worker.js`).
2. **Segurança:** login com hash PBKDF2, cookie de sessão assinado, todas as rotas `/api` exigindo sessão, permissões no servidor, `esc()` na tela. Tela movida para `public/` (antes a raiz inteira, inclusive configs, ficava pública). `worker.js` removido. SSO foi considerado e adiado (depende da TI); ficou usuário e senha.
3. **Integração com o Databricks, opções avaliadas:** (A) API consultando o Databricks a cada acesso, (B) cópia periódica para o D1, (C) migrar para Databricks Apps (pago, só usuários do workspace). **Escolhida B**, com um Job do Databricks que envia os dados. Vercel foi descartado (plano grátis proíbe uso comercial; banco de terceiros com limites). Rodar só no computador da Emilly foi considerado (bom para ela sozinha e para testes), mas ficou o Cloudflare para poder escalar para a equipe.
4. **Tabelas de origem:** `comercial.logint.f_tracking_aereo` (~18 mil linhas, item de NF) e `bemolonline.bol.dados_entregas_mkt_manifest_01` (view lenta e cheia de duplicadas). Nenhuma tem chave única nem coluna de "alterado em"; por isso o Job compara um hash de cada linha.
5. **Acesso:** o Carlos não tinha acesso à segunda tabela; a Emilly fez o próprio login no Databricks CLI (perfil `emilly`) e o Job/notebook ficaram no nome dela. Trocar por um service principal está nas pendências.
6. **Job:** a primeira execução falhou (Emilly sem serverless) e passou a usar o cluster DATA-COMERCIAL-01. A primeira carga (06/10, 11h17) copiou 18.415 + 17.816 linhas.
7. **Limite do D1 estourado:** a carga inicial gerou ~235 mil gravações (cada índice conta), acima das 100 mil/dia do plano grátis, e as leituras chegaram a 3,3 milhões (cada abertura da tela lia a tabela inteira). Correções: sem `COUNT(*)`, filtros em cache, paginação por cursor, índices enxutos (migração 002), Job **1x por dia às 8h** (medição mostrou que as tabelas de origem só mudam 1x por dia).
8. **"Erro interno" no login de CD/comercial:** a conversão da senha antiga para hash é uma gravação, que falhava com o D1 no limite. Agora a falha não derruba o login.
9. **Alterações da Emilly via Gemini (copia e cola no GitHub):** um arquivo da API foi colado cortado (a publicação falhou e o site antigo ficou no ar) e colunas foram usadas com nome errado (`DT_FATURAMENTO` em vez de `dt_faturamento`; campos de `entregas_mkt` lidos na tabela de tracking). Daí as regras 9 e 12 e o item "onde está cada campo" da seção 7.
10. **Coletas LATAM (regras definidas pela Emilly):** só o admin inclui; nasce bloqueada e o botão do admin libera para o CD; várias NFs separadas por "/"; campos CT-e, data da coleta, data do CT-e e entrega no CD; status LATAM na consulta só para o seller Brascol ("Brascol" e "Brascol - ONESHOP" são o mesmo seller). A migração 003 recria `agendamentos` com essas colunas.
11. **Limitações do Claude Code neste projeto:** o modo automático bloqueia o Claude de criar/alterar o Job que envia dados para fora (Cloudflare) e de conceder permissões no Databricks; esses comandos são rodados pela própria pessoa (prefixo `!` no Claude Code).
12. **Ajustes pedidos pela Emilly (06/10, Claude Code):**
    - Campo vazio aparece como `—` em todas as tabelas (função `txt()` em `index.html`); a coluna Destino não mostra mais "ManausSem dados" quando falta UF.
    - A lista de pedidos passou a ser por **`pedido_compra`** (antes `pedido`): coluna PEDIDO_COMPRA, linhas repetidas, paginação (cursor `apos_pedido_compra`) e busca. Índices trocados na migração 004 (`idx_entregas_data_compra`, `idx_entregas_compra` no lugar de `idx_entregas_data` e `idx_entregas_pedido`); a 002 deixou de criar `idx_entregas_data` para não gastar gravações.
    - Abas do CD e do Admin buscam a lista no servidor sempre que abrem (`?escopo=cd|admin`); o CD vê todas as coletas liberadas, não só as 100 mais recentes.
    - Logins e senhas fracos: criado `ferramentas/trocar_senha.ps1` (gera o `UPDATE` com hash PBKDF2 pronto, sem a senha passar pelo chat nem ficar em texto puro no banco).
    - Perfil `cd` não vê o cartão "Inclusão de Coletas (LATAM)" (só a aba "Disponível para Coleta"); a API nega a lista geral ao CD.
    - Tabela "Pedidos Marketplace" fica oculta até a pessoa clicar em Pesquisar (abrir o portal não lê mais `entregas_mkt`).
    - **Card "Consultar Coletas" removido** da aba Consultas a pedido da Emilly, junto com a rota `/api/consulta` (só ele usava). Com isso some também o "status LATAM só para Brascol", que existia só nessa consulta.
    - Sessão conferida no banco a cada requisição: troca de senha/perfil ou exclusão do usuário vale na hora. Ao publicar, todos precisam entrar de novo uma vez (cookies antigos não têm a marca `ver`).
    - Documentação corrigida: o Job roda 1x por dia (8h), não "a cada hora".
13. **Aba Indicadores (07/10, Claude Code):** filtros seller/período (padrão: ano corrente); cartões (pedidos, % no prazo sobre os entregues, fora do prazo, sem entrega, prazos médios em dias); gráfico de pedidos por mês empilhado por situação (HTML puro, sem biblioteca); tabela por seller. Rota `/api/indicadores` faz **uma** consulta agregada por seller × mês (lê as linhas do período uma vez) com cache de 30 min; a tela só busca na primeira abertura da aba e no botão Atualizar. Prazos negativos ou com data faltando ficam fora das médias. Quando um pedido tem linhas com status diferentes, vale o maior em ordem alfabética (`SEM ENTREGA` > `NO PRAZO` > `FORA DO PRAZO`).
14. **Aba Extrair Relatório (07/10, Claude Code):** para os 3 perfis; filtros só de data (do pedido), seller e transportadora (pedido da Emilly). Baixa um **.xlsx** gerado no navegador com SheetJS (cdnjs, com `integrity`, carregado só ao baixar), com todas as colunas de `entregas_mkt` + transportadora e CT-e do tracking. Números longos saem como texto (senão o Excel mostra 9,00E+14) e datas como DD/MM/AAAA. A API entrega em partes de 1.000 linhas com cursor por `rowid` e `+e.dt_pedido` (o `+` impede o índice de data, que faria cada parte reler o período todo): ~6 mil linhas lidas a cada 1.000 do relatório. Uma NF pode ter itens com transportadoras diferentes: a célula lista todas.
    - Depois a Emilly pediu "só LLS" e logo voltou atrás. Ficou a regra por seller (`REGRAS_RELATORIO` em `functions/[[path]].js`): **GRU - KM CARGO só para Brascol, LLS só para Vitrola e Tramontina, e a opção LATAM** (vazia até a LATAM aparecer em `tracking_aereo.transportador`; casa por `LIKE '%LATAM%'`). VIX, WT e as outras não saem. O CT-e mostrado é só o da transportadora da regra.
    - Consumo: uma NF da Vitrola tem dezenas de itens no tracking. Com `EXISTS` + uma subconsulta por coluna, os itens eram lidos 3x (~73 mil linhas lidas por parte de 1.000). Agora uma subconsulta só traz `transportador␟cte` e o pedido entra se ela não for nula (~7 mil por parte; um ano inteiro ~130 mil). LATAM sem dados lê a tabela toda (~40 mil) e não acha nada.
15. **Ferramentas neste PC (07/10):** sem git/node instalados; o Claude usa Node portátil em `%LOCALAPPDATA%\pmkt` (wrangler) e o GitHub CLI portátil para publicar (commit pela API do GitHub). Migrações no banco real são rodadas pela Emilly (o modo automático do Claude bloqueia alteração em produção).
16. **Migrações 002, 003 e 004 aplicadas no banco real (07/10, ~10h).** A tabela `agendamentos` estava vazia, então a 003 não perdeu dados. Até então a inclusão de coleta LATAM dava erro (faltavam `cte`, `data_cte`, `entrega_cd`).
