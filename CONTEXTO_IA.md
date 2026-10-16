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
   │  Job "portamkt - sync Databricks -> D1" (1 vez por dia, às 12h30, fuso America/Manaus)
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
| `comercial` | Consultas, Indicadores, Relatórios, Controle de Pedidos | Só consultar |
| `cd` | Consultas (só "Pedidos Marketplace", **sem** o cartão "Coletas LATAM", antes "Inclusão de Coletas (LATAM)"), Indicadores, Relatórios + "Disponível para Coleta (LATAM)" | Só consultar |
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
| `GET /api/agendamentos` | admin | até 1.000 agendamentos, mais recentes primeiro (cartão "Coletas LATAM" da aba Consultas: a tela mostra só as 3 últimas e o resto com filtro de período ou pesquisa por NF/CT-e/seller, 13/10; desde 08/10 só o admin — CD e comercial recebem 403 e veem "Cargas em Trânsito") |
| `GET /api/agendamentos?escopo=cd` | cd, admin | **todas** as coletas LATAM liberadas (aba "Disponível para Coleta"; recarrega ao abrir a aba) |
| `GET /api/agendamentos?escopo=admin` | admin | todas as coletas LATAM, bloqueadas primeiro (Painel Admin; recarrega ao abrir a aba). Antes de listar, cria como coleta **bloqueada** cada CT-e novo da LATAM (`ctes_latam`, últimos 7 dias, que ainda não está no portal nem está ENTREGUE na planilha; `origem = 'cte'`, no máximo a cada 5 min). Nas 3 listas de coletas, cada item traz `planilha` (achada pelo Nº da coleta, pelo CT-e ou por NF **do mesmo seller**) e `cte_latam` (NFs e emissão do CT-e, que valem sobre as da planilha) |
| `POST /api/agendamentos` `{seller, transportadora, nota_fiscal, cte, data_coleta, data_cte, entrega_cd, status_etapa}` | admin | inclui coleta LATAM. `nota_fiscal` aceita várias NFs separadas por `/`. **Nasce bloqueada** (`liberado_latam = 0`) |
| `PATCH /api/agendamentos/:id/latam` `{liberado_latam: true/false}` | admin | libera (avisa o CD: grava `liberado_em` e zera `visto_cd_em`, a coleta volta a ser NOVA) ou bloqueia a coleta |
| `GET /api/agendamentos/novas` | cd, admin | `{novas}`: liberadas ainda **aguardando coleta** (`status_cd` pendente). Desde 13/10 o contador vermelho do menu some quando o CD confirma a coleta ou o recebimento, não ao abrir a aba (a tela consulta ao entrar, a cada 5 min e depois de cada confirmação) |
| `POST /api/agendamentos/visto` | cd | o CD abriu a aba: marca as liberadas como vistas (tira só o selo NOVA; admin recebe `marcadas: 0`) |
| `PATCH /api/agendamentos/:id/cd` `{acao: coletado/recebido/desfazer}` | cd, admin | confirmação no CD: pendente → coletado → recebido (grava data/hora e `confirmado_por`); `desfazer` volta um passo |
| `GET /api/agendamentos/sugestao?nf=a/b` | admin | preenche a inclusão pela base geral: `{total, encontradas, seller, transportadora, cte, data_coleta, data_cte, entrega_cd, ncoleta, status_planilha}` (pela NF do seller; se nada, pela NF de 9 posições) |
| `GET /api/agendamentos/planilha` | admin | coletas LATAM da planilha com status TRANSITO/PROGRAMADO/AGENDADO/SEFAZ que ainda não estão no portal (lê a base geral; cache 5 min) |
| `POST /api/agendamentos/planilha` `{ncoleta}` | admin | inclui essa coleta já liberada para o CD (`origem = 'planilha'`; dados relidos no servidor) |
| `GET /api/coletas/transito` | logado | `{coletas, atualizado_em}`: "Cargas em Trânsito" (aba Consultas, todos os perfis) — coletas de `coletas_planilha` com status TRANSITO, PROGRAMADO, EM ROTA CD, AGENDADO ou SEFAZ (mesma lista do notebook "aereo markt") |
| `GET /api/indicadores/coletas?seller=&de=&ate=` | logado | `{mensal, origem, mes_origem}`: "Resumo Mensal" e "Resumo por Origem" (Indicadores), regras do notebook "aereo markt": 1ª linha de cada Nº coleta + data, mês da DATA DA COLETA, COLETAS distintas, VALOR TOTAL = soma do VALOR DA NOTA, Lead Time Coleta x CD = média da coluna LEAD TIME; origem = mês mais recente. Mais `lead_time_cliente` (pedido → entrega ao cliente, média dos pedidos do mês na base geral). Cache 30 min |
| `GET /api/entregas?seller=&transportadora=&de=&ate=&busca=&apos_data=&apos_pedido_compra=` | logado | `{itens, tem_mais, proximo, por_pagina}` (50 pedidos de compra por página, sem repetir `pedido_compra`; linhas sem `pedido_compra` não aparecem). Paginação por **cursor**: para a próxima página, envie `apos_data`/`apos_pedido_compra` de `proximo`. Sem data, mostra o ano corrente. `transportadora`: igual ao valor de `base_geral.transportadora`, ou `sem` = ainda sem transportadora (desde 09/10 no lugar do filtro `status`). `busca`: número exato de NF, pedido de compra (`pedido_compra`), ordem ou CT-e (desde 16/10, com ou sem zeros à esquerda) em todo o histórico; se não achar, busca "contém" no ano. **Não retorna total** (ver regra 12) |
| `GET /api/entregas/filtros` | logado | `{sellers: [...], transportadoras: [...]}` para preencher os selects (cache 30 min) |
| `GET /api/indicadores?seller=&de=&ate=` | logado | `{de, ate, seller, grupos}`: um grupo por seller × mês (`mes` = `AAAA-MM`) com `pedidos`, `no_prazo`, `fora_prazo`, `sem_entrega` e somas/quantidades de dias (`soma_pcd/n_pcd` pedido→Entrega CD — antes de 08/10 era pedido→faturamento CD, `soma_ent/n_ent` pedido→entrega cliente, `soma_cd/n_cd` coleta→entrega CD). Sem data, ano corrente. Cada `pedido` conta uma vez. Uma consulta por filtro, em cache por 30 min; a tela soma os grupos |
| `GET /api/indicadores/leadtime?seller=&uf=&de=&ate=` | logado | `{inicio, fim, semanas, linhas}`: uma linha por semana (segunda a domingo, `semana` = data da segunda) da data do pedido, nas até 6 semanas que terminam na semana de `ate` (padrão hoje) e não começam antes da semana de `de`; só conta pedidos entre `de` e `ate`. A tela manda o seller e o período do **filtro geral da aba** (pedido da Emilly: o filtro vale para tudo nos indicadores); a UF é só do card. Médias de dias por etapa (`pedido_nf`, `nf_cte`, `cte_embarque`, `embarque_cd`, `cd_faturamento`, `faturamento_cliente`, `total` = pedido→entrega cliente) com `n_<etapa>` = pedidos na média. Também `ufs`: só as UFs com pedidos nessas semanas (do seller, se escolhido), para o filtro de UF. Cache 30 min |
| `GET /api/controle-pedidos?mes=AAAA-MM&seller=&so=` | admin, comercial | `{mes, seller, hoje, pedidos, recentes}`: aba **Controle de Pedidos**. `pedidos` = um por `pedido_compra` do mês (padrão: mês atual) com as 8 datas (`dt_pedido`, `data_nf`, `data_coleta`, `data_cte`, `data_embarque`, `entrega_cd`, `faturamento`, `entrega_cliente`) + `nf_seller`, `transportadora`; `recentes` = pedidos de 2 a 7 dias atrás (aviso de NF do seller atrasada). `so=aviso` traz só `recentes` (contador do menu). `so=atrasados&seller=` (seller obrigatório) = `{seller, hoje, pedidos}`: pedidos do seller **sem NF** de 2 a 7 dias atrás, para o e-mail de cobrança (só ao clicar, sem cache). A resposta normal e a `so=aviso` trazem também `sem_coleta`: pedidos dos últimos 62 dias com NF do seller de anteontem ou antes e sem coleta nem nenhuma etapa seguinte (alerta "NF emitida e não coletada"). A tela calcula dias por etapa, médias, "aguardando NF" e "considerado cancelado". Lê só o mês pelo índice de data; cache 30 min |
| `POST /api/controle-pedidos/cancelar` `{pedido_compra, cancelado: true/false}` | admin | marca (`true`) ou desfaz (`false`) "pedido cancelado" na tabela `pedidos_cancelados` (grava quem e quando). O `GET /api/controle-pedidos` lê essa tabela a cada chamada (fora do cache): os pedidos do mês vêm com `cancelado_por`/`cancelado_em`, e os cancelados saem de `recentes`, `sem_coleta` e do `so=atrasados` (e-mail de cobrança) |
| `GET /api/relatorio?de=&ate=&seller=&transportadora=&cte=&apos_id=` | logado | `{itens, proximo}`: partes de 1.000 linhas de `base_geral` (todas as colunas; `transportador` e `cte` = só os da regra que vale para o seller da linha). **Só as combinações de `REGRAS_RELATORIO`** (procuradas em `base_geral.transportes`): GRU - KM CARGO só Brascol, LLS só Vitrola e Tramontina, LATAM (vem da planilha). Responde 503 até a 1ª carga da base geral. `transportadora` = `GRU`, `LLS`, `LATAM` ou vazio (todas as regras). `cte` (16/10, opcional) = só as linhas com esse CT-e (número inteiro, com ou sem zeros) da transportadora da regra. Cursor = `rowid` (`_id`); peça a próxima parte com `apos_id=proximo` até vir `null`. Sem data, ano corrente |
| `GET /api/relatorio/filtros` | logado | `{transportadoras: [{valor, rotulo}]}` = `REGRAS_RELATORIO` (não lê o banco) |
| `GET /api/tracking?nf=` | logado | itens da NF na tabela de tracking aéreo |
| `GET /api/sync-status` | logado | data/hora da última sincronização com o Databricks |

No front, todas as chamadas passam pela função `api(caminho, opcoes)` em `public/index.html`, que já trata 401 e erros.

## 7. Banco de dados (D1)

**Tabelas do portal** (editadas pelo portal):
- `usuarios` — `id, username, senha (hash), perfil`
- `agendamentos` (coletas LATAM) — `id, seller, transportadora, nota_fiscal (uma ou mais NFs só com números, separadas por "/", ex.: 617944/617945), cte, data_coleta, data_cte, entrega_cd, status_etapa, liberado_latam (0 = bloqueada, 1 = liberada para o CD), criado_em`. Só o admin inclui; a coleta nasce bloqueada e o admin libera no Painel Admin.
- `pedidos_cancelados` (migração 011, 14/10) — `pedido_compra (INTEGER, chave), cancelado_por, cancelado_em`. Pedidos que o admin marcou como cancelados no Controle de Pedidos; "Desfazer cancelamento" apaga a linha. Tabela pequena, lida inteira a cada abertura da aba. O Job não mexe nela.

**Tabelas espelhadas do Databricks** (somente leitura para o portal; o Job apaga/insere 1x por dia, às 12h30 de Manaus — **não editar à mão nem pelo portal**):
- `entregas_mkt` ← `bemolonline.bol.dados_entregas_mkt_manifest_01`. Um pedido do marketplace por linha. Colunas principais: `pedido, ordem, nf, n_fornecedor (seller), dt_pedido, dt_liberacao, dt_faturamento, dt_entrega, no_prazo (NO PRAZO | SEM ENTREGA | FORA DO PRAZO), cidade, bairro, zona, uf, nota_fiscal_explode, data_coleta, emissao_cte, data_embarque, data_entrega`.
- `tracking_aereo` ← `comercial.logint.f_tracking_aereo`. Um item de NF por linha, com CT-e, transportadora, datas de coleta/embarque/entrega, material e valores. A coluna `etapa` vem em código do sistema (`MANIFEST_01`, `VLPOSTNG_01`, `SCHEDULE_01`…), ainda sem tradução.
- **`base_geral`** ← **as 3 bases unificadas pelo Job** (decisão da Emilly, 07/10): manifest da BOL + tracking aéreo + planilha **CONTROLE_AÉREO_2026.xlsx** dela (SharePoint, aba **"Marketplace"**, lida com Graph API e os secrets `BemolADL/client-id-cd`, `client-secret-cd`, `tenant-id-cd`). Uma linha por linha do manifest, com as mesmas colunas de `entregas_mkt` e mais: datas unificadas (`data_coleta`, `emissao_cte`, `data_embarque`, `data_entrega` = Entrega CD) e `fonte_entrega_cd` (manifest | tracking | planilha); `transportadora` e `cte` (tracking → planilha; vários separados por ", "); `transportes` (pares "transportadora␟cte" do tracking e da planilha, para as regras do relatório); e as colunas da planilha com prefixo `pl_` (`pl_ncoleta, pl_transportadora, pl_cte, pl_origem, pl_destino, pl_volumes, pl_peso, pl_valor_nota, pl_valor_frete, pl_data_coleta, pl_data_cte, pl_previsao_entrega, pl_chegada_mao, pl_agenda_cd, pl_meta, pl_lead_time, pl_dias_atraso, pl_status`; volumes, peso e valores são **da coleta inteira**).
  - **NF do seller vazia no manifest (08/10):** a view tira `nota_fiscal_explode` do tracking, então pedidos sem tracking (toda a LATAM) vinham sem NF e não ligavam com a planilha — "Brascol com KM aparece, com LATAM não". `numero_documento_nove_posicoes` tem a mesma NF (igual em 100% dos 11.677 pedidos com as duas); o Job usa ela quando a primeira falta. Pedidos sem NF: 5.989 → 1.984; LATAM ligados à planilha: 13 → 142.
  - **Junção por NF do seller (10 dígitos) + seller**: o mesmo número de NF existe em sellers diferentes (232 NFs no manifest em 07/10). Seller pelo nome: manifest "Brascol"/"Vitrola"/"Tramontina", tracking `nome_forn` ("ONESHOP DISTRIBUIDORA" = Brascol), planilha FORNECEDOR. Itens do tracking de fornecedores que não são sellers do marketplace ficam de fora.
  - **Pedidos antigos sem NF do seller saem (13/10):** o Job tira do manifest (e com isso de `entregas_mkt` e da `base_geral`) os pedidos sem NF do seller (nem `nota_fiscal_explode` nem `numero_documento_nove_posicoes`) com data até o fim do mês retrasado, sempre deixando 1 mês inteiro sem remover: em outubro saem até 31/08, em novembro até 30/09 (`SEM_NF_ATE` / `remover_antigos_sem_nf()` em `sync_d1.py`). Na 1ª vez saíram 568 pedidos (1.793 linhas, de 2024 a ago/2026).
  - **Data da NF do seller (`emissao`, 13/10):** vem de `comercial.bemolcomercial.btracker_notas` (seller = `nome_forn_emitente`; ONESHOP = Brascol; a Tramontina emite por várias empresas), por NF + seller: vale a 1ª emissão **no dia do pedido ou depois**; sem ela, a do tracking. Antes só o tracking trazia essa data (a LATAM não está lá) e o número da NF se repete entre anos (NF de 2025 em pedido de 2026).
  - **Datas vazias, nesta ordem:** manifest → tracking (maior data válida entre os itens da NF; datas fora de 2000–2099 descartadas — há lixo como o ano 2231) → planilha (Entrega CD = AGENDA CD; **só na LATAM** embarque = DATA CTE, embarque no mesmo dia do CT-e). **Atenção:** a view do manifest junta o tracking só pelo número da NF, então ~200 pedidos traziam datas da NF de OUTRO fornecedor; as datas de tracking do manifest (e `emissao`) só valem quando a NF existe no tracking do mesmo seller.
  - O portal lê só `base_geral` (lista, filtros, indicadores, lead time, relatório) **depois que o Job registra a 1ª carga em `sync_log`** (`tabelaPedidos()` confere a cada 10 min); antes disso usa `entregas_mkt` e o relatório responde 503. Índices enxutos: `(dt_pedido DESC, pedido_compra DESC)`, `pedido_compra`, `nota_fiscal_explode` (busca por NF Bemol/ordem lê a tabela, ~18 mil linhas).
- `ctes_latam` (migração 010) ← `comercial.bemolcomercial.btracker_ctes`: CT-es emitidos pela LATAM (CNPJ raiz 02.012.862) para os sellers do marketplace, desde 01/01/2026, **sem os cancelados** (`situacao = 2`). Um CT-e por linha (`cte` sem zeros à esquerda, `emissao`, `emissao_hora`, `seller`, `notas` "nota / nota", `qtd_notas`, valores). Na base geral, por NF + seller: a emissão do CT-e é a data da coleta, do CT-e e do embarque (depois do manifest e do tracking, antes da planilha), e `transportadora` = LATAM.
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
- **Desde 16/10 são 2 Jobs iguais** (pedido da Emilly: "atualizar todo dia 10h", mantendo o das 12h30): este, às 12h30, e
  `portamkt - sync Databricks -> D1 (10h)` (ID `318486496231655`, configuração em `databricks/job_10h.json`), às **10h**.
  Mesmo notebook, cluster e e-mails de falha. Para mudar o das 10h: `databricks jobs reset` com o ID dele (o
  `ferramentas\atualizar_agendamento.ps1` só mexe no das 12h30).
- Roda no cluster compartilhado **DATA-COMERCIAL-01**, **1 vez por dia, às 12h30** de Manaus (pedido da Emilly em 09/10; antes 8h e 12h, depois 11h30 e 15h30, depois só 11h30, tudo no mesmo dia). Atualiza todas as tabelas de uma vez, e o portal só muda nesse horário (só grava o que mudou desde a execução anterior; cada execução lê ~55 mil linhas para comparar). Tempo máximo 30 min (a execução com a base geral leva ~4 min). Falhas mandam e-mail. Para mudar horário/tempo máximo: editar `databricks/job.json` e rodar `ferramentas\atualizar_agendamento.ps1`.
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

- **Base geral (07/10):** migração 007 aplicada, código publicado e notebook enviado sem rodar. A 1ª carga (~18 mil linhas × 4 ≈ 72 mil gravações) fica para o Job de **08/10 às 12h** (o limite de 100 mil gravações zera à meia-noite UTC = 20h de Manaus). A 1ª carga saiu no Job de 08/10 às 8h (17.666 linhas; Entrega CD em 8.129 pedidos). Falta: apagar `controle_aereo` e, se nada mais usar, parar de sincronizar `entregas_mkt`. Depois, remova este item.
- Compartilhar o Job e a pasta do notebook com `carlossimoes@bemol.com.br` (Can Manage): a Emilly faz pela interface do Databricks (Permissions).
- Traduzir os códigos da coluna `etapa` (`MANIFEST_01`, `VLPOSTNG_01`, …) para nomes legíveis.
- Detalhe do tracking por NF (`/api/tracking`) já existe na API, mas ainda não tem tela.
- O formulário "Nova Coleta LATAM" tem lista fixa de sellers no HTML.
- Limitar tentativas de login (regra de rate limiting no Cloudflare).
- E-mail de cobrança por seller com envio automático (hoje abre no Outlook e a pessoa envia): precisa da permissão `Mail.Send` (Microsoft Graph) liberada pela TI e de uma tabela com o e-mail de cada seller.
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
19. **Base geral (07/10, tarde):** a Emilly pediu os dados unificados (datas, NF, CT-e, pedidos) "sempre usando as 3 bases". Escolheu a **tabela pronta no Job** (em vez de juntar na hora no portal) e **CT-e do tracking, depois do Excel**. Com isso a migração 006 (`tracking_datas_nf`) foi descartada antes de ser aplicada e `controle_aereo` ficou sem uso. Testando no Databricks (notebooks temporários, sem gravar no D1) apareceu que **o mesmo número de NF existe em sellers diferentes**: juntar só pela NF colocava datas de setembro de uma NF da Brascol num pedido da Vitrola de janeiro, e as 236 NFs "GRU + LLS" eram colisões. A própria view do manifest da BOL tem o problema (~200 pedidos com datas de tracking de outro fornecedor). Daí a junção por NF + seller e a regra de só aceitar as datas de tracking do manifest quando a NF existe no tracking do mesmo seller. Resultado no teste (17.870 linhas): Entrega CD de 2.354 para 8.446 pedidos (planilha 5.894, tracking 198), coleta de 2.649 para 8.492, nenhuma Entrega CD antes do pedido; LATAM = 13 pedidos, só Brascol (set–out). A lista de Consultas ganhou TRANSPORTADORA e CT-E; o Excel do relatório, FONTE ENTREGA CD. A 1ª carga saiu no Job de 08/10 às 8h. Depois, a pedido dela, a lista e o Excel ganharam **ETAPA ATUAL** (`etapaAtual()` em `index.html`): a etapa mais avançada com data na base geral — Pedido → NF emitida → Coletado → CT-e emitido → Embarcado → Entregue no CD → Faturado (CD) → Entregue ao cliente; vale para todas as transportadoras, inclusive LATAM da planilha. A coluna Status (prazo) continua.
23. **Planilha com prioridade nas coletas LATAM (09/10):** a pedido dela, nas três listas de coletas (CD, Painel Admin, Inclusão) valem os dados da coleta na planilha (`coletas_planilha`, achada pelo Nº da coleta ou por qualquer NF): **todas as NFs** (formato "nota / nota"), CT-e, datas e Entrega CD = AGENDA CD; o "Recebido no CD" vira conferência ("✓ CD confirmou no mesmo dia" / "⚠ CD marcou recebido em dd/mm"; sem planilha ainda: dia do recebimento + "aguardando planilha"). As sugestões do Painel Admin e o preenchimento da inclusão passaram a vir de `coletas_planilha` (antes da base geral, que só tinha as NFs já ligadas a pedidos — a coleta 447 entrou com 1 das 7 NFs). Coleta da planilha ainda sem NFs pode ser liberada.
22. **Entrega CD pelo recebimento + confirmação da planilha (09/10):** quando o CD marca "Recebido no CD", a coluna Entrega CD da aba do CD mostra o dia do recebimento (de `recebido_em`, no fuso de Manaus; não grava em `entrega_cd`, então "Desfazer" volta ao que era). No dia seguinte a planilha traz a AGENDA CD: `listarAgendamentos` anexa `planilha_agenda_cd` (pelo Nº da coleta em `coletas_planilha` ou, sem ele, pelas NFs na base geral) e a tela mostra "✓ confirmado na planilha" (mesmo dia), "⚠ na planilha: dd/mm" (dia diferente) ou "aguardando planilha". Aparece também no Painel Admin, junto da Situação no CD.
21. **Cargas em Trânsito e resumos de coletas (08/10):** "Inclusão de Coletas (LATAM)" ficou só para o admin; no lugar, para todos, o card **Cargas em Trânsito** (igual ao e-mail do notebook "aereo markt"). Nos Indicadores, **Resumo Mensal** (+ coluna Lead Time Pedido x Entrega Cliente) e **Resumo por Origem**, com o filtro geral da aba. Fonte: tabela nova `coletas_planilha` (migração 009; o Job manda a aba Marketplace por linha, ~452 linhas). Conferido no Databricks: os 10 meses do Resumo Mensal e as 4 coletas em trânsito batem exatamente com o relatório dela.
20. **Sinalizador de coletas LATAM do CD01 (08/10):** a Emilly pediu os 4: (a) **aviso de coleta nova** — contador vermelho no menu "Disponível para Coleta (LATAM)" e selo NOVA nas liberadas que o CD ainda não abriu (`visto_cd_em`); (b) **CD confirma** — botões "Confirmar coleta" e "Recebido no CD" (com data/hora e usuário; "Desfazer" volta um passo), visíveis também no Painel Admin; (c) **preencher pela planilha** — ao digitar as NFs na inclusão, busca na base geral e completa CT-e, datas, seller e Nº da coleta (não deixa incluir a mesma coleta duas vezes); (d) **sinalizar direto da base** — card no Painel Admin com as coletas LATAM da planilha a caminho, botão "Liberar para o CD". Migração 008 (só acrescenta colunas em `agendamentos`). Testado num portal local com usuários admin e cd.
24. **NF repetida entre sellers (09/10):** a Emilly viu a NF 409436 como Vitrola/LLS, mas ela estava na coleta LATAM 453 da
    Brascol. São duas NFs com o mesmo número: Vitrola (coleta 115, ESSENCIAL CARGO/LLS, pedido de 11/03) e Brascol (coleta 453,
    LATAM, pedido 4509035154 de 07/10). A coleta LATAM do portal estava certa. Na consulta só aparecia a Vitrola porque o pedido
    da Brascol chegou ao D1 **sem NF**: o manifest da BOL só preencheu a NF depois do Job das 12h. Regra pedida por ela: quando a
    NF se repete, a consulta traz **todas, a mais recente primeiro**. A busca já faz isso (`ORDER BY dt_pedido DESC`), então não
    mudou código; as duas aparecem a partir do Job seguinte.
25. **Contexto atualizado 1 vez por dia (09/10, pedido da Emilly):** ver `CLAUDE.md`.
26. **Filtro de transportadora em Pedidos Marketplace (09/10):** a pedido dela, o filtro "Status" virou "Transportadora", com
    as transportadoras da base geral (em 09/10: LLS, GRU - KM CARGO, LATAM, ESSENCIAL CARGO, KM CARGO) e "Sem transportadora"
    (~6 mil pedidos). A coluna Status (prazo) da tabela continua.
27. **Job 1x por dia às 12h30 (09/10):** antes era 8h e 12h. Ela pediu 11h30 e 15h00. Um agendamento só não aceita minutos
    diferentes, então ficou primeiro 11h30 e 15h30; no mesmo dia ela decidiu rodar só às 11h30 e, por fim, só às 12h30. Aplicado no Databricks pelo
    Claude com `jobs update` (mesmo conteúdo de `ferramentas\atualizar_agendamento.ps1`).
28. **Cache do manifest reaproveitado entre Jobs (09/10):** a execução das 14h gravou 0 linhas novas em `entregas_mkt`, mesmo
    com a view já trazendo a NF 409436 no pedido 4509035154 da Brascol. Causa: `manifest...cache()` no cluster compartilhado
    DATA-COMERCIAL-01, que fica ligado entre os Jobs. O cache do Spark vale para o cluster todo, então a execução seguinte
    reaproveitava o manifest da anterior. A 1ª correção (`unpersist` antes do `cache()`) fez o Job falhar: o Spark tentou
    recalcular o cache antigo e não tinha a chave do storage `strdatafactory`. Correção final: **sem `.cache()`**; o manifest
    é lido 1x e vira uma cópia local (`spark.createDataFrame(_manifest.collect(), schema)`, ~18 mil linhas). Teste num
    notebook temporário: 17.959 linhas e a NF da Brascol presente. Nunca use `.cache()` nesse cluster.
    O notebook no Databricks recebeu a correção **sem** a parte dos CT-es LATAM (que ainda não está no ar), pelo script
    `%LOCALAPPDATA%\pmkt\enviar_notebook.ps1` rodado pela Emilly.
29. **CT-es da LATAM direto do btracker (09/10):** a Emilly perguntou se o portal conseguia puxar direto da base de CT-e. O
    portal só lê o D1, então o Job copia `comercial.bemolcomercial.btracker_ctes` para `ctes_latam` (migração 010). O que
    apareceu nos dados (Brascol, 08/09 a 08/10): 25 CT-es; `situacao = 2` é CT-e cancelado (713863 refeito como 713869);
    há CT-e refeito sem cancelamento (722341 e 722358, mesmas 17 NFs; a planilha usa o 722358); **3 CT-es não estavam na
    planilha** (728256, 731119, 733788); e a planilha tinha menos NFs que o CT-e em várias coletas (447: 7 na planilha,
    19 no CT-e 732164). Decisões dela: cada CT-e novo vira coleta LATAM **bloqueada** (o admin libera); as NFs do CT-e valem
    sobre as da planilha; a emissão do CT-e é a data da coleta e do embarque. Para não encher o Painel Admin de coletas
    antigas, só viram coleta os CT-es dos últimos 7 dias que não estão ENTREGUE na planilha. Teste no Databricks (só
    leitura): pedidos LATAM na base geral de 157 para 225. Testado num portal local com os casos reais (CT-e já no portal,
    entregue, refeito, fora da planilha). Junto: a coleta achada por NF passou a respeitar o seller (antes uma NF da
    Brascol podia pegar a coleta da Vitrola com o mesmo número). Migração, notebook e 1ª execução pelo script
    `%LOCALAPPDATA%\pmkt\ctes_latam.ps1`, rodado pela Emilly em **13/10 às ~9h10** (24 CT-es em `ctes_latam`; base geral
    com 331 linhas trocadas); o código do portal foi publicado logo depois.
30. **Data da NF do seller pelo btracker (13/10):** no Lead Time semanal da Brascol, "Pedido → NF Seller" e
    "NF Seller → CTE" vinham `—` em todas as semanas: a data da NF (`emissao`) só vinha do tracking, e a Brascol recente é
    LATAM (fora do tracking). A pedido dela ("unificando com a NF e o CT-e para ser uma base só"), o Job passou a ler
    `btracker_notas` (`ler_datas_nf()` em `sync_d1.py`; cobre ~9,3 mil NFs dos 3 sellers em 2026; 236 das 239 NFs dos
    CT-es LATAM desde agosto). Apareceu também que a data do tracking estava errada em 60 pedidos da Brascol/GRU (NF do
    ano anterior com o mesmo número, ex.: NF 384615 do pedido de 11/06/2026 com emissão em 24/09/2025), por isso o
    btracker vale antes do tracking e só a 1ª emissão no dia do pedido ou depois. Teste num notebook temporário (só
    leitura): Brascol W37–W41 de 0 para 41–56 pedidos com NF por semana (Pedido → NF 0,6–1,4 dia; NF → CTE 0,2–0,6),
    negativos 60 → 0. Sem coluna nova (a `emissao` já existia). A Emilly enviou o notebook e rodou o Job em 13/10 ~16h
    (base geral +438 / −456; a 2ª execução logo depois deu +0 / −0).
32. **Pedidos antigos sem NF do seller removidos (13/10):** a pedido dela, saem do portal os pedidos sem NF
    do seller (tudo vazio na lista, ex.: 4508966647, Tramontina, 31/08) até o fim do mês retrasado, e o corte anda com
    os meses deixando sempre 1 mês inteiro (em outubro até 31/08; em novembro até 30/09). Feito no Job, no manifest
    antes de sincronizar, então vale para `entregas_mkt` e `base_geral` (apagar à mão não adianta: o Job recopia).
    Teste num notebook temporário (só leitura): saem 568 pedidos / 1.793 linhas (de 2024 a ago/2026), nenhum com NF e
    nenhum depois do corte; base geral 17.926 → 16.133. A Emilly enviou o notebook e rodou o Job em 13/10 à tarde:
    −1.793 linhas em `entregas_mkt` e em `base_geral`, igual ao teste.
31. **Card "Coletas LATAM" (13/10):** a pedido dela, "Inclusão de Coletas (LATAM)" virou "Coletas LATAM", com filtro de
    período (data da coleta; sem ela, o dia da inclusão) e pesquisa (NF, CT-e ou seller). Sem filtro, só as 3 últimas
    coletas aparecem; o resto só com pesquisa. A API passou de 100 para 1.000 coletas nessa lista (tabela pequena), para a
    pesquisa achar as antigas. Filtro feito na tela, sem consulta nova ao banco.
33. **Aba Controle de Pedidos (13/10):** a pedido dela, só para admin e comercial (a API confere). Um pedido de compra por
    linha com as 8 datas (pedido, NF do seller, coleta, CT-e, embarque, Entrega CD, faturamento, entrega ao cliente) e,
    embaixo de cada data, os dias desde a etapa anterior ("+1 d"); cartões com a média de cada etapa e o total (pedido →
    cliente); filtro de mês (padrão: mês atual, com faixa azul nas linhas) e de seller. Regras (decisão dela): pedido sem
    NF do seller há **mais de 1 dia** = "aguardando NF" (card de aviso com os pedidos de 2 a 7 dias atrás, contador
    laranja no menu, Pedido → NF acima de 1 dia em laranja); sem NF e **sem nenhuma data há mais de 7 dias** =
    "considerado cancelado" (contado no mês e fora das médias). Sem tabela nova: lê a `base_geral` (o pedido falava em
    "outra base", mas as datas já estão todas nela e uma tabela nova gastaria gravações do Job). Testado num portal
    local com pedidos de exemplo (completo, aguardando, cancelado, de ontem, NF demorada, outro mês, linha repetida).
    Os pedidos sem NF de antes do mês retrasado já saem pelo Job (item 32), então cancelados aparecem só nos meses recentes.
    Depois, a pedido dela, o card de aviso mostra os dias sem NF de dois jeitos: **corridos** e **úteis** (sem sábado,
    domingo e feriados nacionais; Sexta-feira Santa calculada pela Páscoa; Carnaval e Corpus Christi contam como dia útil
    por serem ponto facultativo) — `diasUteis()` em `index.html`. A regra de "aguardando" (mais de 1 dia) segue em dias corridos.
35. **E-mail de cobrança por seller (13/10):** card na aba Controle de Pedidos, a pedido dela: escolhe o seller, "sem NF há
    mais de N dias" (padrão 5) e dias corridos ou úteis; o portal monta assunto + texto + tabela (pedido de compra, data,
    dias corridos e úteis). **O portal não envia**: "Copiar e-mail (com tabela)" põe HTML na área de transferência para
    colar no Outlook; "Abrir no programa de e-mail" usa `mailto:` (só texto, escondido se a lista passar de ~1.800
    caracteres). "Sem faturamento" = sem NF do seller (mesma regra do aviso). Testado no portal local. Depois ela pediu
    que o e-mail use **sempre os pedidos dos últimos 7 dias** (depois disso, sem nenhum dado, o pedido já conta como
    cancelado); por isso o limite de dias vai de 1 a 6. Em seguida pediu que o card fique **por último** na aba e que
    o e-mail vá "direto pro Outlook": o botão **Abrir no Outlook** abre uma mensagem nova no Outlook na web
    (`outlook.office.com/mail/deeplink/compose`, conta Bemol) com assunto e texto, e no mesmo clique copia o e-mail com
    a tabela formatada (Ctrl+V); "Abrir no Outlook do computador" usa `mailto:`. Ela ainda põe o destinatário e clica em
    Enviar. **Envio automático** (sem abrir o Outlook) exigiria a permissão `Mail.Send` da Microsoft Graph para o portal,
    liberada pela TI, e o e-mail dos sellers no banco — fica como pendência.
36. **Alerta "NF emitida e não coletada" (13/10):** a pedido dela, card laranja na aba Controle de Pedidos (e cartão de
    contagem, selo "NF sem coleta" na lista do mês e soma no contador do menu): pedidos com NF do seller há **mais de
    24h** e sem coleta nem nenhuma etapa seguinte. A base só tem a data (sem hora), então "24h" = NF de anteontem ou
    antes (NF de ontem pode não ter 24h). Janela: pedidos dos últimos 62 dias; respeita o seller do filtro. Mostra dias
    sem coleta corridos e úteis. Testado no portal local (NF de ontem e NF já coletada ficam de fora).
34. **Aviso vermelho do CD pela situação da coleta (13/10):** a pedido dela, o contador vermelho do menu "Disponível para
    Coleta", o fundo vermelho da linha e o selo NOVA valem enquanto a coleta está **aguardando coleta**; somem quando o
    CD confirma a coleta ou o recebimento (antes sumiam quando o CD só abria a aba). "Desfazer" volta o aviso. Testado
    no portal local (1 → confirmar coleta 0 → desfazer 1; abrir a aba mantém 1).
37. **Ajustes de 14/10 (Indicadores e Controle de Pedidos, pedidos da Emilly):**
    - **TOTAL (Lead Time) do Lead Time semanal — só conferência, sem mudança:** ela perguntou se, em "Todos os sellers -
      Geral", o TOTAL somava as etapas. **Não soma.** O TOTAL é uma etapa própria (`['total', 'dt_pedido', 'dt_entrega']`
      em `ETAPAS_LEAD_TIME`, `functions/[[path]].js`): a média, por semana, dos dias entre a **data do pedido** e a
      **entrega ao cliente**, só com os pedidos que têm as duas datas — exatamente o que ela queria ("média total da 1ª
      etapa, data do pedido, até a entrega ao cliente"). Com "Todos os sellers" a conta é a mesma, com todos os sellers e
      UFs. Por isso o TOTAL **não bate com a soma das linhas de cima**: cada etapa tem o seu grupo de pedidos (só os que
      têm as duas datas dela) e o TOTAL só conta pedidos já entregues ao cliente; nas semanas recentes ele tem poucos
      pedidos ou fica `—`. O tooltip de cada célula mostra "média de N pedidos". Se alguém pedir de novo "TOTAL = soma",
      lembrar que a decisão (item 17) foi ponta a ponta porque `data_entrega` vem vazia em muitos pedidos.
    - **Pedido concluído em verde:** na lista do mês do Controle de Pedidos, o pedido com **as 8 datas preenchidas**
      (pedido, NF seller, coleta, CT-e, embarque, Entrega CD, faturamento, entrega ao cliente) fica com a linha **verde
      clara** (`bg-emerald-50`) e o selo **"concluído"** embaixo do número do pedido. A regra é `concluido =
      DATAS_CONTROLE.every(([c]) => p[c])` em `mostrarControle()` (`index.html`) e vale antes dos outros selos. O rodapé
      da tabela explica: "em verde, os concluídos (todas as etapas)". Exemplo dela: 4509034397 (Vitrola, 07/10 → 12/10, 5 d).
    - **Filtro de seller nos dois cards de aviso:** "⚠ Pedidos sem NF do seller há mais de 1 dia" (`ctl_aguardando_seller`)
      e "🚚 NF emitida e não coletada há mais de 24h" (`ctl_sem_coleta_seller`) ganharam um select de seller cada, no
      canto direito do card. O filtro é **feito na tela** sobre a lista já carregada (`avisosControle` +
      `mostrarAvisosControle()` / `filtroSellerAviso()`), **sem consulta nova ao banco** (regra 12). As opções são só os
      sellers que aparecem na lista daquele card; a escolha fica ao recarregar se o seller ainda estiver na lista. O
      filtro de seller do topo da aba continua igual (ele restringe o que a API devolve; o do card filtra dentro disso).
      O contador laranja do menu não muda com esses filtros.
    - **Card "NF emitida e não coletada" sem a coluna Transportadora** (a pedido dela). A API continua mandando
      `transportadora` em `sem_coleta`; só a tela deixou de mostrar.
    - Só `public/index.html` mudou (sem API, sem banco). Publicado em 2 commits na `main` (777276a e 51e069c), os dois
      com "Cloudflare Pages: success". Neste PC o `npx` não está no PATH: a publicação foi conferida pelo check-run do
      commit no GitHub (`gh api repos/emillymonte22/portamkt/commits/<sha>/check-runs`). Testado só a sintaxe do JS
      (`node --check` no script da página); a tela foi conferida pela Emilly ("deu certo").
    - Job do Databricks de 14/10 às 12h30: **sucesso** (run 539809688788451).
38. **Admin marca pedido como cancelado (14/10):** a pedido dela, na lista do mês do Controle de Pedidos o **admin**
    tem, embaixo do número de cada pedido, o botão **"Marcar como cancelado"** (pede confirmação) e, no cancelado,
    **"Desfazer cancelamento"**. Decisões dela: **só o admin** marca (o comercial só vê; a API devolve 403) e **sem
    motivo** (grava só quem marcou e quando — aparece passando o mouse no selo). Pedido cancelado: selo vermelho
    "cancelado", linha cinza, fora das médias e do Total, fora do aviso "aguardando NF", do alerta "NF sem coleta", do
    contador do menu e do e-mail de cobrança; não fica verde de "concluído". O cartão "Considerados cancelados no mês"
    virou **"Cancelados no mês"** e soma os marcados pelo admin + os automáticos (sem NF e sem nenhuma data há mais de
    7 dias, que continuam com o selo cinza "considerado cancelado"). Tabela nova `pedidos_cancelados` (migração 011),
    lida a cada consulta fora do cache de 30 min para o cancelamento valer na hora. Testado num portal local:
    comercial 403, pedido inválido 400, admin marca → aparece `cancelado_por`/`cancelado_em` para admin e comercial,
    sai de `sem_coleta`; desfazer volta ao normal. Depois ela pediu o botão também no card **"⚠ Pedidos sem NF do
    seller há mais de 1 dia"** (que mostra pedidos de 2 a 7 dias atrás, às vezes de outro mês que o da lista): o admin
    marca direto ali e o pedido sai do card na hora. Para desfazer, escolher o mês do pedido na lista e clicar em
    "Desfazer cancelamento".
39. **Filtro de seller em "Média de dias por etapa" (14/10):** a pedido dela, o card do Controle de Pedidos ganhou um
    select de seller próprio (`ctl_medias_seller`), igual aos dos cards de aviso: filtra na tela os pedidos do mês já
    carregados (sem os cancelados), sem consulta nova ao banco; as opções são os sellers com pedidos no mês. Recalcula
    as 7 etapas e o Total (`mostrarMediasControle()` / `mediaDias()` em `index.html`). O cartão "Lead time médio" do
    topo continua com todos os sellers do filtro geral da aba.
40. **Busca por número do pedido no Controle de Pedidos (14/10):** a pedido dela, caixa "Número do pedido" em cima da
    tabela de pedidos (`ctl_busca`, `filtrarPedidosControle()`): mostra só as linhas do mês carregado cujo número
    **contém** o que foi digitado (aceita parte do número; ignora o que não é dígito), com "N pedido(s) encontrado(s)".
    Filtra na tela, sem consulta ao banco; vale dentro do mês e do seller do filtro geral (se não achar, a tela avisa
    para conferir o mês). A busca continua aplicada ao trocar de mês ou cancelar/desfazer um pedido.
41. **Dias sem NF na coluna NF seller (14/10):** a pedido dela, na tabela de pedidos do Controle de Pedidos, o pedido
    ainda sem NF do seller mostra embaixo do `—` da coluna NF SELLER "sem NF há X d" (dias corridos desde o pedido)
    e "Y d úteis" — a mesma conta do card "⚠ Pedidos sem NF do seller" (`difDias` e `diasUteis`). Em laranja quando
    passa de 1 dia (aguardando NF); cinza para pedidos de hoje e ontem. Não aparece em pedidos cancelados (pelo admin
    ou "considerado cancelado").
42. **Verde de "concluído" pelo Total (14/10):** a pedido dela, a linha verde clara + selo "concluído" do Controle
    de Pedidos (item 37) passou a valer **sempre que o Total estiver preenchido** (data do pedido e entrega ao
    cliente, diferença não negativa), mesmo faltando datas intermediárias. Antes exigia as 8 datas. Cancelado pelo
    admin nunca fica verde.
43. **Card "⚠ Pedidos sem NF do seller há mais de 1 dia" removido (14/10):** a pedido dela, depois que os dias sem NF
    (corridos e úteis) passaram para a coluna NF SELLER da tabela (item 41), o card saiu da tela, junto com o filtro de
    seller e o botão de cancelar que ele tinha (o botão continua na tabela). Continuam: o cartão "Aguardando NF do
    seller (+1 dia)", o contador laranja do menu (a API ainda manda `recentes`) e o card "🚚 NF emitida e não coletada".
    Atenção: a tabela mostra só o mês escolhido; no começo do mês, pedidos de 2 a 7 dias atrás do mês anterior ficam
    no cartão/contador, mas para vê-los é preciso escolher o mês anterior.
44. **Busca e relatório por CT-e (16/10):** a pedido dela, a caixa de busca da aba Consultas passou a se chamar "NF,
    pedido de compra, ordem ou CT-e" e acha também o CT-e, e o Extrair Relatório ganhou o campo **CT-e** (`rel_cte`,
    opcional). Os dois procuram em `base_geral.transportes` com `filtroCte()` (`functions/[[path]].js`): número inteiro,
    com ou sem zeros à esquerda (o tracking grava `0000148149`, a planilha/LATAM e outras transportadoras `148149`).
    Na busca, o CT-e entra no **1º passo** junto com pedido de compra e NF do seller, para um CT-e com o mesmo número
    de uma NF de outro pedido não ficar escondido. Custo: sem índice no CT-e, toda busca por número lê a tabela
    (~18 mil linhas; antes só quando o pedido/NF não era achado); a busca "contém" (3º passo) também olha o CT-e. No
    relatório, o CT-e precisa ser o da transportadora da regra do seller (ex.: o CT-e da ESSENCIAL CARGO de uma NF da
    LLS não traz a linha); o cursor anda pelas linhas lidas, mesmo as tiradas por esse filtro. O nome do arquivo ganha
    `_cte<número>`. Testado no banco real só leitura (CT-e 148149 → pedidos da Vitrola) e no portal local (busca e
    relatório com e sem zeros, CT-e fora da regra, CT-e inválido).
45. **2ª atualização diária às 10h (16/10):** a pedido dela ("atualizar esse portal todo dia 10h, já criar o job",
    "não cancelar", "deixa como está"), criado um 2º Job, `portamkt - sync Databricks -> D1 (10h)` (ID
    `318486496231655`, `databricks/job_10h.json`), cópia do Job das 12h30 com horário `0 0 10 * * ?` (Manaus). O das
    12h30 continua igual. Cada execução lê ~55 mil linhas para comparar e grava só o que mudou (cabe no plano grátis).
    Atenção: as tabelas de origem mudam 1x por dia (item 7); se ainda não tiverem mudado às 10h, essa execução não
    traz nada novo e quem atualiza é a das 12h30.
16. **Migrações 002, 003 e 004 aplicadas no banco real (07/10, ~10h).** A tabela `agendamentos` estava vazia, então a 003 não perdeu dados. Até então a inclusão de coleta LATAM dava erro (faltavam `cte`, `data_cte`, `entrega_cd`).
