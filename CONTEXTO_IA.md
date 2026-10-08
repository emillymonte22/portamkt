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
   │  Job "portamkt - sync Databricks -> D1" (2 vezes por dia, às 8h e às 12h, fuso America/Manaus)
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
| `databricks/sync_d1.py` → também monta a base geral | Além das 2 tabelas, lê a aba "Marketplace" da CONTROLE_AÉREO_2026.xlsx (SharePoint) e monta `base_geral` (função `montar_base_geral()`). |
| `databricks/sync_d1.py` | Notebook do Job que copia os dados do Databricks para o D1. |
| `databricks/job.json` | Configuração do Job no Databricks (cluster, horário, e-mails). |
| `CONTEXTO_IA.md` | Este arquivo. |
| `CLAUDE.md` | Instruções para o Claude Code (carrega este arquivo automaticamente). |
| `ferramentas/atualizar_agendamento.ps1` | Aplica no Job o horário, o tempo máximo e a descrição de `databricks/job.json` (não mexe no notebook). |
| `ferramentas/atualizar_job.ps1` | Reenvia `databricks/sync_d1.py` ao Databricks e roda o Job uma vez. |
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
| `GET /api/indicadores/leadtime?seller=&uf=&de=&ate=` | logado | `{inicio, fim, semanas, linhas}`: uma linha por semana (segunda a domingo, `semana` = data da segunda) da data do pedido, nas até 6 semanas que terminam na semana de `ate` (padrão hoje) e não começam antes da semana de `de`; só conta pedidos entre `de` e `ate`. A tela manda o seller e o período do **filtro geral da aba** (pedido da Emilly: o filtro vale para tudo nos indicadores); a UF é só do card. Médias de dias por etapa (`pedido_nf`, `nf_cte`, `cte_embarque`, `embarque_cd`, `cd_faturamento`, `faturamento_cliente`, `total` = pedido→entrega cliente) com `n_<etapa>` = pedidos na média. Também `ufs`: só as UFs com pedidos nessas semanas (do seller, se escolhido), para o filtro de UF. Cache 30 min |
| `GET /api/relatorio?de=&ate=&seller=&transportadora=&apos_id=` | logado | `{itens, proximo}`: partes de 1.000 linhas de `base_geral` (todas as colunas; `transportador` e `cte` = só os da regra que vale para o seller da linha). **Só as combinações de `REGRAS_RELATORIO`** (procuradas em `base_geral.transportes`): GRU - KM CARGO só Brascol, LLS só Vitrola e Tramontina, LATAM (vem da planilha). Responde 503 até a 1ª carga da base geral. `transportadora` = `GRU`, `LLS`, `LATAM` ou vazio (todas as regras). Cursor = `rowid` (`_id`); peça a próxima parte com `apos_id=proximo` até vir `null`. Sem data, ano corrente |
| `GET /api/relatorio/filtros` | logado | `{transportadoras: [{valor, rotulo}]}` = `REGRAS_RELATORIO` (não lê o banco) |
| `GET /api/tracking?nf=` | logado | itens da NF na tabela de tracking aéreo |
| `GET /api/sync-status` | logado | data/hora da última sincronização com o Databricks |

No front, todas as chamadas passam pela função `api(caminho, opcoes)` em `public/index.html`, que já trata 401 e erros.

## 7. Banco de dados (D1)

**Tabelas do portal** (editadas pelo portal):
- `usuarios` — `id, username, senha (hash), perfil`
- `agendamentos` (coletas LATAM) — `id, seller, transportadora, nota_fiscal (uma ou mais NFs só com números, separadas por "/", ex.: 617944/617945), cte, data_coleta, data_cte, entrega_cd, status_etapa, liberado_latam (0 = bloqueada, 1 = liberada para o CD), criado_em`. Só o admin inclui; a coleta nasce bloqueada e o admin libera no Painel Admin.

**Tabelas espelhadas do Databricks** (somente leitura para o portal; o Job apaga/insere 2x por dia, às 8h e às 12h de Manaus — **não editar à mão nem pelo portal**):
- `entregas_mkt` ← `bemolonline.bol.dados_entregas_mkt_manifest_01`. Um pedido do marketplace por linha. Colunas principais: `pedido, ordem, nf, n_fornecedor (seller), dt_pedido, dt_liberacao, dt_faturamento, dt_entrega, no_prazo (NO PRAZO | SEM ENTREGA | FORA DO PRAZO), cidade, bairro, zona, uf, nota_fiscal_explode, data_coleta, emissao_cte, data_embarque, data_entrega`.
- `tracking_aereo` ← `comercial.logint.f_tracking_aereo`. Um item de NF por linha, com CT-e, transportadora, datas de coleta/embarque/entrega, material e valores. A coluna `etapa` vem em código do sistema (`MANIFEST_01`, `VLPOSTNG_01`, `SCHEDULE_01`…), ainda sem tradução.
- **`base_geral`** ← **as 3 bases unificadas pelo Job** (decisão da Emilly, 07/10): manifest da BOL + tracking aéreo + planilha **CONTROLE_AÉREO_2026.xlsx** dela (SharePoint, aba **"Marketplace"**, lida com Graph API e os secrets `BemolADL/client-id-cd`, `client-secret-cd`, `tenant-id-cd`). Uma linha por linha do manifest, com as mesmas colunas de `entregas_mkt` e mais: datas unificadas (`data_coleta`, `emissao_cte`, `data_embarque`, `data_entrega` = Entrega CD) e `fonte_entrega_cd` (manifest | tracking | planilha); `transportadora` e `cte` (tracking → planilha; vários separados por ", "); `transportes` (pares "transportadora␟cte" do tracking e da planilha, para as regras do relatório); e as colunas da planilha com prefixo `pl_` (`pl_ncoleta, pl_transportadora, pl_cte, pl_origem, pl_destino, pl_volumes, pl_peso, pl_valor_nota, pl_valor_frete, pl_data_coleta, pl_data_cte, pl_previsao_entrega, pl_chegada_mao, pl_agenda_cd, pl_meta, pl_lead_time, pl_dias_atraso, pl_status`; volumes, peso e valores são **da coleta inteira**).
  - **Junção por NF do seller (10 dígitos) + seller**: o mesmo número de NF existe em sellers diferentes (232 NFs no manifest em 07/10). Seller pelo nome: manifest "Brascol"/"Vitrola"/"Tramontina", tracking `nome_forn` ("ONESHOP DISTRIBUIDORA" = Brascol), planilha FORNECEDOR. Itens do tracking de fornecedores que não são sellers do marketplace ficam de fora.
  - **Datas vazias, nesta ordem:** manifest → tracking (maior data válida entre os itens da NF; datas fora de 2000–2099 descartadas — há lixo como o ano 2231) → planilha (Entrega CD = AGENDA CD; **só na LATAM** embarque = DATA CTE, embarque no mesmo dia do CT-e). **Atenção:** a view do manifest junta o tracking só pelo número da NF, então ~200 pedidos traziam datas da NF de OUTRO fornecedor; as datas de tracking do manifest (e `emissao`) só valem quando a NF existe no tracking do mesmo seller.
  - O portal lê só `base_geral` (lista, filtros, indicadores, lead time, relatório) **depois que o Job registra a 1ª carga em `sync_log`** (`tabelaPedidos()` confere a cada 10 min); antes disso usa `entregas_mkt` e o relatório responde 503. Índices enxutos: `(dt_pedido DESC, pedido_compra DESC)`, `pedido_compra`, `nota_fiscal_explode` (busca por NF Bemol/ordem lê a tabela, ~18 mil linhas).
- `controle_aereo` (migração 005) — criada para a 1ª versão da planilha e **não é mais usada** (vazia; a planilha entra direto na base geral). Pode ser apagada depois que o portal estiver na base geral.
- `sync_log` — uma linha por execução do Job (`tabela, executado_em, total_origem, inseridos, removidos`).
- **Onde está cada campo** (não confundir): na `base_geral` está tudo junto (use ela); nas tabelas de origem, `dt_faturamento`, `dt_entrega` e `no_prazo` só existem em `entregas_mkt`; `data_coleta`, `emissao_cte`, `data_embarque`, `data_entrega` (entrega no CD) e `emissao` estão em `tracking_aereo`; `liberado_latam`, `cte`, `entrega_cd` e `status_etapa` só em `agendamentos`.
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
- Roda no cluster compartilhado **DATA-COMERCIAL-01**, 2 vezes por dia, **às 8h e às 12h** de Manaus (pedido da Emilly em 08/10; até então só 8h). Atualiza todas as tabelas de uma vez, e o portal só muda nesses horários (só grava o que mudou desde a execução anterior; cada execução lê ~55 mil linhas para comparar). Tempo máximo 60 min. Falhas mandam e-mail. Para mudar horário/tempo máximo: editar `databricks/job.json` e rodar `ferramentas\atualizar_agendamento.ps1`.
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

- **Base geral (07/10):** migração 007 aplicada, código publicado e notebook enviado sem rodar. A 1ª carga (~18 mil linhas × 4 ≈ 72 mil gravações) fica para o Job de **08/10 às 12h** (o limite de 100 mil gravações zera à meia-noite UTC = 20h de Manaus). A 1ª carga saiu no Job de 08/10 às 8h (17.666 linhas; Entrega CD em 8.129 pedidos). Falta: aplicar o horário 8h e 12h no Databricks (`ferramentas\atualizar_agendamento.ps1`, rodado pela Emilly); apagar `controle_aereo` e, se nada mais usar, parar de sincronizar `entregas_mkt`. Depois, remova este item.
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
13. **Aba Indicadores (07/10, Claude Code):** filtros seller/período (padrão: ano corrente); cartões (pedidos, % no prazo sobre os entregues, fora do prazo, sem entrega, prazos médios em dias); gráfico de pedidos por mês (HTML puro, sem biblioteca; depois, a pedido dela, barras numa cor só e clara com o total do mês + linha de evolução em SVG ligando os pontos — a situação da entrega aparece só no tooltip); tabela por seller. Rota `/api/indicadores` faz **uma** consulta agregada por seller × mês (lê as linhas do período uma vez) com cache de 30 min; a tela só busca na primeira abertura da aba e no botão Atualizar. Prazos negativos ou com data faltando ficam fora das médias. Quando um pedido tem linhas com status diferentes, vale o maior em ordem alfabética (`SEM ENTREGA` > `NO PRAZO` > `FORA DO PRAZO`).
14. **Aba Extrair Relatório (07/10, Claude Code):** para os 3 perfis; filtros só de data (do pedido), seller e transportadora (pedido da Emilly). Baixa um **.xlsx** gerado no navegador com SheetJS (cdnjs, com `integrity`, carregado só ao baixar), com todas as colunas de `entregas_mkt` + transportadora e CT-e do tracking. Números longos saem como texto (senão o Excel mostra 9,00E+14) e datas como DD/MM/AAAA. A API entrega em partes de 1.000 linhas com cursor por `rowid` e `+e.dt_pedido` (o `+` impede o índice de data, que faria cada parte reler o período todo): ~6 mil linhas lidas a cada 1.000 do relatório. Uma NF pode ter itens com transportadoras diferentes: a célula lista todas.
    - Depois a Emilly pediu "só LLS" e logo voltou atrás. Ficou a regra por seller (`REGRAS_RELATORIO` em `functions/[[path]].js`): **GRU - KM CARGO só para Brascol, LLS só para Vitrola e Tramontina, e a opção LATAM** (vazia até a LATAM aparecer em `tracking_aereo.transportador`; casa por `LIKE '%LATAM%'`). VIX, WT e as outras não saem. O CT-e mostrado é só o da transportadora da regra.
    - Consumo: uma NF da Vitrola tem dezenas de itens no tracking. Com `EXISTS` + uma subconsulta por coluna, os itens eram lidos 3x (~73 mil linhas lidas por parte de 1.000). Agora uma subconsulta só traz `transportador␟cte` e o pedido entra se ela não for nula (~7 mil por parte; um ano inteiro ~130 mil). LATAM sem dados lê a tabela toda (~40 mil) e não acha nada.
15. **Ferramentas neste PC (07/10):** sem git/node instalados; o Claude usa Node portátil em `%LOCALAPPDATA%\pmkt` (wrangler) e o GitHub CLI portátil para publicar (commit pela API do GitHub). Migrações no banco real são rodadas pela Emilly (o modo automático do Claude bloqueia alteração em produção).
17. **Lead Time semanal na aba Indicadores (07/10, modelo enviado pela Emilly):** card "<SELLER> - <UF ou Geral> / Lead Time semanal", tabela etapas × semanas ISO (W34, W35…, com datas e nº de pedidos), linha TOTAL destacada. Filtros **próprios** de seller e UF (só desse card, recarrega ao trocar); a janela de 6 semanas termina no "Até" do filtro geral (ou hoje). Etapas: Pedido→NF Seller (`dt_pedido`→`emissao`), NF Seller→CTE (`emissao`→`emissao_cte`), CTE→Embarque (`emissao_cte`→`data_embarque`), Embarque→Entrega CD (`data_embarque`→`data_entrega`), Entrega CD→Faturamento Bemol (`data_entrega`→`dt_faturamento`), Faturamento→Entrega Cliente (`dt_faturamento`→`dt_entrega`). **TOTAL = média de pedido→entrega ao cliente** (não a soma das etapas: `data_entrega` vem vazia na maioria dos pedidos e a soma ficaria errada). Etapa sem pedidos com as duas datas mostra `—`. Ajustes pedidos depois: tabela compacta (largura do conteúdo, coluna Etapa estreita, período da semana numa linha) e o filtro de UF lista só as UFs que têm pedidos do seller nas semanas exibidas (trocar o seller volta a UF para "Todas").
18. **Planilha CONTROLE_AÉREO no portal (07/10):** a Emilly pediu para completar os dados que faltam com a planilha dela. Medição: a "Entrega CD" vinha vazia em ~77% dos pedidos; a aba Marketplace (453 coletas → 7.937 NFs em 07/10, de jan a 05/10) tem AGENDA CD em 7.925 NFs e as datas batem com o banco quando os dois têm. Decisões dela: Entrega CD = **AGENDA CD** (não CHEGADA MAO); **banco primeiro**; trazer datas, coleta/CT-e, valores/carga e previsão/status. Feito: migração 005 (`controle_aereo`), leitura da planilha no `databricks/sync_d1.py` (mesma lógica de hash das outras tabelas; as tabelas do Databricks sincronizam antes, então se o SharePoint falhar elas já foram), lista de pedidos/indicadores/lead time/relatório usando as datas completadas, e 18 colunas da planilha no Excel do relatório. Testado: leitura real da planilha num notebook temporário no Databricks (sem gravar no D1) e as rotas num portal local com dados de exemplo. A planilha tem a transportadora **LATAM**: a pedido da Emilly, a opção LATAM do relatório passou a procurar também na planilha (`fontes: ['tracking', 'planilha']` em `REGRAS_RELATORIO`; subconsulta `_pc` em `controle_aereo`, só montada quando alguma regra escolhida usa a planilha). Migração 005 aplicada em 07/10 ~12h. Para reenviar o notebook e rodar o Job: `ferramentas/atualizar_job.ps1`. **LATAM (regra da Emilly):** o embarque é no mesmo dia do CT-e, então para NF de coleta LATAM na planilha a data de embarque vazia vira a DATA CTE da planilha, e a Entrega CD vem da AGENDA CD (no tracking não há LATAM, então na prática vale sempre o Excel). No lead time, CTE → Embarque da LATAM dá 0. Depois ela pediu que o que falta venha primeiro **das outras bases do Databricks**: o tracking completa ~240 embarques, ~230 coletas e ~90 Entregas CD só entre 17/08 e 07/10. Somar o tracking em cada consulta subiu o lead time de 1,6 mil para 33 mil linhas lidas, então o Job passou a montar `tracking_datas_nf` (migração 006). Em 07/10 a planilha tinha 143 NFs LATAM, todas da Brascol (08/09 a 05/10).
19. **Base geral (07/10, tarde):** a Emilly pediu os dados unificados (datas, NF, CT-e, pedidos) "sempre usando as 3 bases". Escolheu a **tabela pronta no Job** (em vez de juntar na hora no portal) e **CT-e do tracking, depois do Excel**. Com isso a migração 006 (`tracking_datas_nf`) foi descartada antes de ser aplicada e `controle_aereo` ficou sem uso. Testando no Databricks (notebooks temporários, sem gravar no D1) apareceu que **o mesmo número de NF existe em sellers diferentes**: juntar só pela NF colocava datas de setembro de uma NF da Brascol num pedido da Vitrola de janeiro, e as 236 NFs "GRU + LLS" eram colisões. A própria view do manifest da BOL tem o problema (~200 pedidos com datas de tracking de outro fornecedor). Daí a junção por NF + seller e a regra de só aceitar as datas de tracking do manifest quando a NF existe no tracking do mesmo seller. Resultado no teste (17.870 linhas): Entrega CD de 2.354 para 8.446 pedidos (planilha 5.894, tracking 198), coleta de 2.649 para 8.492, nenhuma Entrega CD antes do pedido; LATAM = 13 pedidos, só Brascol (set–out). A lista de Consultas ganhou TRANSPORTADORA e CT-E; o Excel do relatório, FONTE ENTREGA CD.
16. **Migrações 002, 003 e 004 aplicadas no banco real (07/10, ~10h).** A tabela `agendamentos` estava vazia, então a 003 não perdeu dados. Até então a inclusão de coleta LATAM dava erro (faltavam `cte`, `data_cte`, `entrega_cd`).
