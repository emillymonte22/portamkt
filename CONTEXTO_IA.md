# Contexto do projeto para IAs (ChatGPT, Gemini, Copilot, Claude…)

> **Como usar:** antes de pedir qualquer alteração a uma IA, cole este arquivo inteiro no início da conversa
> e, junto, o arquivo que você quer mudar (normalmente `public/index.html` ou `functions/[[path]].js`).
> Peça para a IA devolver o arquivo **completo** já alterado e respeitar as regras da seção "Regras obrigatórias".

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
| `d1/migracao_*.sql` | Alterações de banco já aplicadas (histórico). |
| `databricks/sync_d1.py` | Notebook do Job que copia os dados do Databricks para o D1. |
| `databricks/job.json` | Configuração do Job no Databricks (cluster, horário, e-mails). |
| `CONTEXTO_IA.md` | Este arquivo. |

Arquivos fora de `public/` **não** ficam acessíveis pela internet.

## 4. Perfis de usuário

Login com usuário e senha (tabela `usuarios`). Três perfis:

| Perfil | Vê | Pode |
|---|---|---|
| `comercial` | Consultas, Indicadores, Relatórios | Só consultar |
| `cd` | Tudo do comercial + "Disponível para Coleta (LATAM)" | Só consultar |
| `admin` | Tudo + "Painel Admin (Sinalização)" | **Incluir coletas LATAM** e liberar/bloquear cargas para o CD |

## 5. Autenticação e segurança (como funciona)

- `POST /api/login` confere a senha e devolve um **cookie `sessao`** (HttpOnly, Secure, SameSite=Strict) assinado com HMAC-SHA256 usando o secret `SESSION_SECRET` (configurado no Cloudflare, **nunca** no código). Validade: 8 horas.
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
| `GET /api/agendamentos` | logado | últimos 100 agendamentos |
| `POST /api/agendamentos` `{seller, transportadora, nota_fiscal, cte, data_coleta, data_cte, entrega_cd, status_etapa}` | admin | inclui coleta LATAM. `nota_fiscal` aceita várias NFs separadas por `/`. **Nasce bloqueada** (`liberado_latam = 0`) |
| `PATCH /api/agendamentos/:id/latam` `{liberado_latam: true/false}` | admin | libera (avisa o CD) ou bloqueia a coleta |
| `GET /api/entregas?seller=&status=&de=&ate=&busca=&apos_data=&apos_pedido=` | logado | `{itens, tem_mais, proximo, por_pagina}` (50 pedidos por página, sem repetir pedido). Paginação por **cursor**: para a próxima página, envie `apos_data`/`apos_pedido` de `proximo`. Sem data, mostra o ano corrente. `busca`: número exato de NF, pedido ou ordem em todo o histórico; se não achar, busca "contém" no ano. **Não retorna total** (ver regra 12) |
| `GET /api/entregas/filtros` | logado | `{sellers: [...], status: [...]}` para preencher os selects |
| `GET /api/tracking?nf=` | logado | itens da NF na tabela de tracking aéreo |
| `GET /api/consulta?nf=` | logado | `{tracking, entrega, coleta}`: a NF nas três fontes (tracking do Databricks, pedido do marketplace e coleta LATAM do portal). Usada na "Consulta de coletas" para calcular o status |
| `GET /api/sync-status` | logado | data/hora da última sincronização com o Databricks |

No front, todas as chamadas passam pela função `api(caminho, opcoes)` em `public/index.html`, que já trata 401 e erros.

## 7. Banco de dados (D1)

**Tabelas do portal** (editadas pelo portal):
- `usuarios` — `id, username, senha (hash), perfil`
- `agendamentos` (coletas LATAM) — `id, seller, transportadora, nota_fiscal (uma ou mais NFs só com números, separadas por "/", ex.: 617944/617945), cte, data_coleta, data_cte, entrega_cd, status_etapa, liberado_latam (0 = bloqueada, 1 = liberada para o CD), criado_em`. Só o admin inclui; a coleta nasce bloqueada e o admin libera no Painel Admin.

**Tabelas espelhadas do Databricks** (somente leitura para o portal; o Job apaga/insere a cada hora — **não editar à mão nem pelo portal**):
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
11. Só o admin inclui coletas LATAM; o status LATAM na consulta aparece só para o seller Brascol.
12. **Limites do plano grátis do D1:** 5 milhões de linhas lidas e 100 mil gravadas por dia. Não usar `COUNT(*)` nem consultas sem `WHERE`/`LIMIT` na tabela inteira a cada abertura de tela; não criar índices sem necessidade (cada índice multiplica as gravações do Job).

## 9. Como publicar e testar

- **Publicar:** commit + push na `main` → o Cloudflare publica sozinho. Acompanhar em dash.cloudflare.com → Workers & Pages → portamkt.
- **Testar no computador** (precisa de Node.js):
  ```
  npx wrangler login
  npx wrangler d1 execute portamkt-db --local --file d1/schema.sql
  echo SESSION_SECRET=qualquer-texto-longo-para-teste > .dev.vars
  npx wrangler pages dev
  ```
  Abre em http://localhost:8788 com um banco local vazio (crie usuários de teste com `npx wrangler d1 execute portamkt-db --local --command "INSERT INTO usuarios ..."`; senha em texto puro vira hash no primeiro login).
- **Aplicar migração no banco real:** `npx wrangler d1 execute portamkt-db --remote --file d1/migracao_00X_....sql`

## 10. Job do Databricks

- Nome: `portamkt - sync Databricks -> D1` (ID `1025737974527673`), notebook em `/Users/emillymonte@bemol.com.br/portamkt/sync_d1`.
- Roda no cluster compartilhado **DATA-COMERCIAL-01**, 1 vez por dia, às 8h (as tabelas de origem só mudam 1x por dia). Falhas mandam e-mail.
- Lê as duas tabelas sem linhas repetidas, calcula um hash por linha e só envia ao D1 o que mudou (insere novas, apaga as que sumiram). Tem trava: se a origem vier com menos da metade das linhas, aborta sem apagar nada.
- Usa o secret `portamkt/cloudflare_token` do Databricks (API Token do Cloudflare com permissão D1:Edit).
- Alterou `databricks/sync_d1.py`? É preciso reenviar o notebook ao Databricks:
  `databricks workspace import /Users/emillymonte@bemol.com.br/portamkt/sync_d1 --file databricks/sync_d1.py --language PYTHON --format SOURCE --overwrite`

## 11. Pendências conhecidas

- **Aplicar no banco real** (depois que o limite diário do D1 zerar, 20h de Manaus): `d1/migracao_002_indices_leves.sql` e `d1/migracao_003_coletas_latam.sql`. Até aplicar a 003, incluir coleta dá erro.

- Traduzir os códigos da coluna `etapa` (`MANIFEST_01`, `VLPOSTNG_01`, …) para nomes legíveis.
- Abas "Indicadores" e "Extrair Relatório" ainda são placeholders.
- Detalhe do tracking por NF (`/api/tracking`) já existe na API, mas ainda não tem tela.
- O formulário "Consultar Agendamento" tem listas fixas de seller/transportadora no HTML.
- Limitar tentativas de login (regra de rate limiting no Cloudflare).
- Trocar o dono do Job por um usuário de serviço (service principal) em vez de uma pessoa.
- Futuro: possível migração para a workstation NVIDIA do setor (via Cloudflare Tunnel).
