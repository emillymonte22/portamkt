// API do portal (Cloudflare Pages Functions).
// Toda rota /api/* exige sessão, exceto /api/login. A sessão é um cookie HttpOnly assinado
// com HMAC (env.SESSION_SECRET); o perfil é checado aqui no servidor, não só na tela.

const SESSAO_SEGUNDOS = 8 * 60 * 60;
const PBKDF2_ITERACOES = 100000; // máximo aceito pelo PBKDF2 do Workers
const ITENS_POR_PAGINA = 50;

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  if (!path.startsWith('/api/')) return next();

  if (!env.SESSION_SECRET) {
    console.error('SESSION_SECRET não configurado');
    return erro(500, 'Servidor sem configuração de sessão');
  }

  if (['POST', 'PATCH'].includes(request.method) &&
      !(request.headers.get('Content-Type') || '').includes('application/json')) {
    return erro(415, 'Envie JSON');
  }

  try {
    if (path === '/api/login' && request.method === 'POST') return await login(request, env);
    if (path === '/api/logout' && request.method === 'POST') return logout();

    const usuario = await lerSessao(request, env);
    if (!usuario) return erro(401, 'Sessão expirada. Faça login novamente.');

    if (path === '/api/me' && request.method === 'GET') return Response.json(usuario);

    if (path === '/api/agendamentos') {
      if (request.method === 'GET') {
        const escopo = url.searchParams.get('escopo') || '';
        if (escopo === 'cd' && !['cd', 'admin'].includes(usuario.perfil)) return erro(403, 'Apenas CD e administrador');
        if (escopo === 'admin' && usuario.perfil !== 'admin') return erro(403, 'Apenas o administrador');
        // O CD só vê as coletas liberadas (escopo=cd), não a lista geral de inclusão
        if (escopo === '' && usuario.perfil === 'cd') return erro(403, 'O CD vê as coletas na aba Disponível para Coleta');
        return await listarAgendamentos(env, escopo);
      }
      if (request.method === 'POST') {
        if (usuario.perfil !== 'admin') return erro(403, 'Apenas o administrador pode incluir coletas');
        return await criarAgendamento(request, env);
      }
    }

    const latam = path.match(/^\/api\/agendamentos\/(\d+)\/latam$/);
    if (latam && request.method === 'PATCH') {
      if (usuario.perfil !== 'admin') return erro(403, 'Apenas o administrador pode liberar cargas');
      return await alterarLiberacaoLatam(request, env, Number(latam[1]));
    }

    if (path === '/api/entregas' && request.method === 'GET') return await listarEntregas(env, url.searchParams);
    if (path === '/api/entregas/filtros' && request.method === 'GET') return await filtrosEntregas(env);
    if (path === '/api/indicadores' && request.method === 'GET') return await indicadores(env, url.searchParams);
    if (path === '/api/relatorio' && request.method === 'GET') return await relatorio(env, url.searchParams);
    if (path === '/api/relatorio/filtros' && request.method === 'GET') return filtrosRelatorio();
    if (path === '/api/tracking' && request.method === 'GET') return await listarTracking(env, url.searchParams);
    if (path === '/api/sync-status' && request.method === 'GET') return await statusSync(env);

    return erro(404, 'Rota não encontrada');
  } catch (err) {
    console.error(err);
    return erro(500, 'Erro interno');
  }
}

// ---------- Autenticação ----------

async function login(request, env) {
  const { username, senha } = await request.json().catch(() => ({}));
  if (typeof username !== 'string' || typeof senha !== 'string' || !username || !senha) {
    return erro(400, 'Informe utilizador e senha');
  }

  const user = await env.DB.prepare('SELECT id, username, senha, perfil FROM usuarios WHERE username = ?')
    .bind(username).first();

  let valido = false;
  let senhaGravada = user?.senha;
  if (user && user.senha.startsWith('pbkdf2$')) {
    valido = await verificarSenha(senha, user.senha);
  } else if (user) {
    // Senha ainda em texto puro (cadastro antigo ou senha trocada pelo wrangler): confere e tenta converter para hash.
    // Se a gravação falhar (ex.: limite diário do D1), o login segue e tenta de novo na próxima vez.
    valido = iguais(senha, user.senha);
    if (valido) {
      try {
        const hash = await gerarHashSenha(senha);
        await env.DB.prepare('UPDATE usuarios SET senha = ? WHERE id = ?').bind(hash, user.id).run();
        senhaGravada = hash;
      } catch (err) {
        console.error('Não foi possível converter a senha para hash', err);
      }
    }
  }
  if (!valido) return erro(401, 'Utilizador ou senha incorretos');

  const sessao = { username: user.username, perfil: user.perfil };
  const token = await assinar({
    ...sessao,
    ver: await versaoSenha(senhaGravada, env.SESSION_SECRET),
    exp: Math.floor(Date.now() / 1000) + SESSAO_SEGUNDOS,
  }, env.SESSION_SECRET);
  return Response.json(sessao, {
    headers: { 'Set-Cookie': `sessao=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSAO_SEGUNDOS}` },
  });
}

function logout() {
  return Response.json({ success: true }, {
    headers: { 'Set-Cookie': 'sessao=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' },
  });
}

async function lerSessao(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const token = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('sessao='))?.slice(7);
  if (!token) return null;

  const [corpo, assinatura] = token.split('.');
  if (!corpo || !assinatura) return null;
  if (!iguais(assinatura, await hmac(corpo, env.SESSION_SECRET))) return null;

  const dados = JSON.parse(new TextDecoder().decode(deBase64Url(corpo)));
  if (dados.exp < Date.now() / 1000) return null;

  // Confere o usuário no banco a cada requisição (1 linha, pelo índice de username): usuário apagado,
  // perfil alterado ou senha trocada valem na hora, sem esperar as 8 horas do cookie.
  const user = await env.DB.prepare('SELECT username, senha, perfil FROM usuarios WHERE username = ?')
    .bind(dados.username).first();
  if (!user || !iguais(String(dados.ver || ''), await versaoSenha(user.senha, env.SESSION_SECRET))) return null;
  return { username: user.username, perfil: user.perfil };
}

// Marca da senha gravada no cookie: se a senha mudar no banco, as sessões abertas com a senha antiga caem
async function versaoSenha(senhaGravada, segredo) {
  return (await hmac(`senha:${senhaGravada}`, segredo)).slice(0, 16);
}

async function assinar(dados, segredo) {
  const corpo = base64Url(new TextEncoder().encode(JSON.stringify(dados)));
  return `${corpo}.${await hmac(corpo, segredo)}`;
}

async function hmac(texto, segredo) {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(texto)));
}

async function gerarHashSenha(senha, sal = crypto.getRandomValues(new Uint8Array(16)), iteracoes = PBKDF2_ITERACOES) {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteracoes }, chave, 256);
  return `pbkdf2$${iteracoes}$${base64Url(sal)}$${base64Url(bits)}`;
}

async function verificarSenha(senha, armazenado) {
  const [, iteracoes, sal] = armazenado.split('$');
  return iguais(await gerarHashSenha(senha, deBase64Url(sal), Number(iteracoes)), armazenado);
}

function iguais(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let dif = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) dif |= (x[i] || 0) ^ (y[i] || 0);
  return dif === 0;
}

function base64Url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deBase64Url(texto) {
  const b64 = texto.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)), c => c.charCodeAt(0));
}

// ---------- Agendamentos ----------

// Consultas: últimos 100. CD: todas as coletas LATAM liberadas. Admin: todas as LATAM, bloqueadas primeiro.
// A tabela é pequena (digitada no portal); o LIMIT é só uma proteção (regra 12).
const SQL_AGENDAMENTOS = {
  '': 'SELECT * FROM agendamentos ORDER BY id DESC LIMIT 100',
  cd: `SELECT * FROM agendamentos WHERE UPPER(transportadora) = 'LATAM' AND liberado_latam = 1 ORDER BY id DESC LIMIT 1000`,
  admin: `SELECT * FROM agendamentos WHERE UPPER(transportadora) = 'LATAM' ORDER BY liberado_latam, id DESC LIMIT 1000`,
};

async function listarAgendamentos(env, escopo) {
  const sql = SQL_AGENDAMENTOS[escopo];
  if (!sql) return erro(400, 'escopo inválido');
  const { results } = await env.DB.prepare(sql).all();
  return Response.json(results);
}

async function criarAgendamento(request, env) {
  const b = await request.json().catch(() => ({}));
  const obrigatorios = ['seller', 'transportadora', 'nota_fiscal'];
  if (obrigatorios.some(c => typeof b[c] !== 'string' || !b[c].trim())) {
    return erro(400, `Campos obrigatórios: ${obrigatorios.join(', ')}`);
  }

  // Várias NFs separadas por "/" (ex.: "617944/617945"); guarda só os números, sem zeros à esquerda
  const notas = normalizarNotas(b.nota_fiscal);
  if (!notas) return erro(400, 'Informe ao menos uma NF (separe várias com "/")');

  const datas = {};
  for (const campo of ['data_coleta', 'data_cte', 'entrega_cd']) {
    const v = b[campo] || null;
    if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return erro(400, `${campo} inválida`);
    datas[campo] = v;
  }

  // A coleta nasce bloqueada: o admin libera depois pelo Painel Admin, avisando o CD
  await env.DB.prepare(
    `INSERT INTO agendamentos (seller, transportadora, nota_fiscal, cte, data_coleta, data_cte, entrega_cd, status_etapa, liberado_latam)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    b.seller.trim(),
    b.transportadora.trim(),
    notas,
    String(b.cte || '').trim().slice(0, 200),
    datas.data_coleta,
    datas.data_cte,
    datas.entrega_cd,
    String(b.status_etapa || 'Emissão do Pedido').slice(0, 60),
  ).run();
  return Response.json({ success: true });
}

function normalizarNotas(texto) {
  const notas = String(texto).split('/')
    .map(n => n.replace(/\D/g, '').replace(/^0+/, ''))
    .filter(Boolean);
  return [...new Set(notas)].join('/');
}

async function alterarLiberacaoLatam(request, env, id) {
  const { liberado_latam } = await request.json().catch(() => ({}));
  if (typeof liberado_latam !== 'boolean') return erro(400, 'liberado_latam deve ser true ou false');
  const { meta } = await env.DB.prepare('UPDATE agendamentos SET liberado_latam = ? WHERE id = ?')
    .bind(liberado_latam ? 1 : 0, id).run();
  if (!meta.changes) return erro(404, 'Agendamento não encontrado');
  return Response.json({ success: true });
}

// ---------- Dados do Databricks ----------

async function listarEntregas(env, p) {
  const filtros = [];
  const valores = [];

  const seller = p.get('seller');
  if (seller) {
    filtros.push('n_fornecedor = ?');
    valores.push(seller);
  }

  const status = p.get('status');
  if (status && status !== 'Todos') {
    filtros.push('no_prazo = ?');
    valores.push(status);
  }

  const busca = (p.get('busca') || '').trim();

  const ano = new Date().getFullYear();
  const de = p.get('de') || (busca ? '' : `${ano}-01-01`);
  if (de) {
    filtros.push('dt_pedido >= ?');
    valores.push(de);
  }

  const ate = p.get('ate') || (busca ? '' : `${ano}-12-31`);
  if (ate) {
    filtros.push('dt_pedido <= ?');
    valores.push(ate);
  }

  // A lista é por pedido de compra; linhas sem pedido_compra não aparecem (e quebrariam o cursor)
  filtros.push('pedido_compra IS NOT NULL');

  // Paginação por cursor (data + pedido de compra do último item da página anterior): usa o índice
  // idx_entregas_data_compra e lê só as linhas da página, em vez de pular linhas com OFFSET.
  const aposData = p.get('apos_data');
  const aposPedidoCompra = Number(p.get('apos_pedido_compra'));
  if (aposData && aposPedidoCompra) {
    filtros.push('(dt_pedido, pedido_compra) < (?, ?)');
    valores.push(aposData, aposPedidoCompra);
  }

  if (!busca) return Response.json(await paginaEntregas(env, filtros, valores));

  // Busca por número de NF, pedido de compra ou ordem (aceita digitar com pontos, traços etc.)
  const numero = busca.replace(/\D/g, '');
  if (!numero || numero.length > 18) return erro(400, 'Busque por número de NF, pedido de compra ou ordem');

  // 1º: número exato, usando os índices (leve)
  const n = Number(numero);
  const exata = await paginaEntregas(env,
    [...filtros, '(nf = ? OR pedido_compra = ? OR ordem = ? OR nota_fiscal_explode = ?)'],
    [...valores, n, n, n, nfTracking(numero)]);
  if (exata.itens.length || aposData || numero.length < 4) return Response.json(exata);

  // 2º: nada exato → busca parcial ("contém"), limitada ao período (ano corrente se não informado)
  // para não ler a tabela inteira
  const filtrosParcial = [...filtros];
  const valoresParcial = [...valores];
  if (!p.get('de') && !p.get('ate')) {
    const ano = new Date().getFullYear();
    filtrosParcial.push('dt_pedido BETWEEN ? AND ?');
    valoresParcial.push(`${ano}-01-01`, `${ano}-12-31`);
  }
  const contem = `%${numero}%`;
  filtrosParcial.push('(CAST(pedido_compra AS TEXT) LIKE ? OR CAST(ordem AS TEXT) LIKE ? OR CAST(nf AS TEXT) LIKE ? OR nota_fiscal_explode LIKE ?)');
  valoresParcial.push(contem, contem, contem, contem);
  return Response.json(await paginaEntregas(env, filtrosParcial, valoresParcial));
}

// Busca até 3x o tamanho da página e junta as linhas repetidas do mesmo pedido de compra
// (elas vêm lado a lado por causa da ordenação), sem GROUP BY, que obrigaria a ler tudo.
async function paginaEntregas(env, filtros, valores) {
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
  const limite = ITENS_POR_PAGINA * 3;
  const { results } = await env.DB.prepare(
    `SELECT * FROM entregas_mkt ${where} ORDER BY dt_pedido DESC, pedido_compra DESC LIMIT ?`
  ).bind(...valores, limite).all();

  const linhas = results || [];
  const itens = [];
  for (const linha of linhas) {
    const anterior = itens[itens.length - 1];
    if (anterior && anterior.pedido_compra === linha.pedido_compra) continue;
    itens.push(linha);
  }
  const pagina = itens.slice(0, ITENS_POR_PAGINA);
  const ultimo = pagina[pagina.length - 1];
  return {
    itens: pagina,
    tem_mais: itens.length > ITENS_POR_PAGINA || linhas.length === limite,
    proximo: ultimo ? { apos_data: ultimo.dt_pedido, apos_pedido_compra: ultimo.pedido_compra } : null,
    por_pagina: ITENS_POR_PAGINA,
  };
}

let cacheFiltros = null;
const CACHE_FILTROS_MS = 30 * 60 * 1000;

async function filtrosEntregas(env) {
  if (!cacheFiltros || Date.now() - cacheFiltros.em > CACHE_FILTROS_MS) {
    const [sellers, status] = await env.DB.batch([
      env.DB.prepare('SELECT DISTINCT n_fornecedor AS v FROM entregas_mkt WHERE n_fornecedor IS NOT NULL ORDER BY 1'),
      env.DB.prepare('SELECT DISTINCT no_prazo AS v FROM entregas_mkt WHERE no_prazo IS NOT NULL ORDER BY 1'),
    ]);
    cacheFiltros = {
      em: Date.now(),
      dados: { sellers: sellers.results.map(r => r.v), status: status.results.map(r => r.v) },
    };
  }
  return Response.json(cacheFiltros.dados);
}

// Indicadores por seller e mês (a tela soma os grupos para os totais).
// Uma consulta só, que lê as linhas do período uma vez (regra 12); a tabela muda 1x por dia, então o
// resultado fica em cache por 30 min para a mesma combinação de filtros.
// Cada pedido conta uma vez: as linhas repetidas do mesmo pedido são juntadas no GROUP BY pedido.
const cacheIndicadores = new Map();

async function indicadores(env, p) {
  const ano = new Date().getFullYear();
  const de = p.get('de') || `${ano}-01-01`;
  const ate = p.get('ate') || `${ano}-12-31`;
  if (![de, ate].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) return erro(400, 'Datas inválidas');
  if (de > ate) return erro(400, 'A data inicial é maior que a final');
  const seller = p.get('seller') || '';

  const chave = JSON.stringify([de, ate, seller]);
  const guardado = cacheIndicadores.get(chave);
  if (guardado && Date.now() - guardado.em < CACHE_FILTROS_MS) return Response.json(guardado.dados);

  const filtros = ['dt_pedido BETWEEN ? AND ?', 'pedido IS NOT NULL'];
  const valores = [de, ate];
  if (seller) {
    filtros.push('n_fornecedor = ?');
    valores.push(seller);
  }

  // Prazos em dias só contam quando as duas datas existem e a diferença não é negativa
  const { results } = await env.DB.prepare(
    `WITH base AS (
       SELECT pedido,
              MAX(n_fornecedor) AS seller, MAX(dt_pedido) AS dt_pedido, UPPER(TRIM(MAX(no_prazo))) AS status,
              julianday(MAX(dt_faturamento)) - julianday(MAX(dt_pedido)) AS d_fat,
              julianday(MAX(dt_entrega))     - julianday(MAX(dt_pedido)) AS d_ent,
              julianday(MAX(data_entrega))   - julianday(MAX(data_coleta)) AS d_cd
       FROM entregas_mkt WHERE ${filtros.join(' AND ')}
       GROUP BY pedido
     )
     SELECT seller, substr(dt_pedido, 1, 7) AS mes, COUNT(*) AS pedidos,
            SUM(status = 'NO PRAZO') AS no_prazo,
            SUM(status = 'FORA DO PRAZO') AS fora_prazo,
            SUM(status = 'SEM ENTREGA') AS sem_entrega,
            SUM(CASE WHEN d_fat >= 0 THEN d_fat END) AS soma_fat, COUNT(CASE WHEN d_fat >= 0 THEN 1 END) AS n_fat,
            SUM(CASE WHEN d_ent >= 0 THEN d_ent END) AS soma_ent, COUNT(CASE WHEN d_ent >= 0 THEN 1 END) AS n_ent,
            SUM(CASE WHEN d_cd  >= 0 THEN d_cd  END) AS soma_cd,  COUNT(CASE WHEN d_cd  >= 0 THEN 1 END) AS n_cd
     FROM base GROUP BY seller, mes ORDER BY mes, seller`
  ).bind(...valores).all();

  const dados = { de, ate, seller, grupos: results || [] };
  if (cacheIndicadores.size > 50) cacheIndicadores.clear();
  cacheIndicadores.set(chave, { em: Date.now(), dados });
  return Response.json(dados);
}

// Relatório para baixar: todas as colunas de entregas_mkt + transportadora e CT-e do tracking (pela NF).
// A tela pede em partes de 1.000 linhas e monta o arquivo. O cursor é o rowid: cada parte continua de onde a
// anterior parou, então o download inteiro lê a tabela uma vez só (regra 12), e cada resposta fica pequena.
const LINHAS_POR_PARTE_RELATORIO = 1000;

async function relatorio(env, p) {
  const ano = new Date().getFullYear();
  const de = p.get('de') || `${ano}-01-01`;
  const ate = p.get('ate') || `${ano}-12-31`;
  if (![de, ate].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) return erro(400, 'Datas inválidas');
  if (de > ate) return erro(400, 'A data inicial é maior que a final');

  // O "+" impede o SQLite de usar o índice de data aqui: com ele, cada parte releria o período inteiro para
  // ordenar por rowid; sem ele, percorre a tabela em ordem de rowid e para ao juntar 1.000 linhas.
  const filtros = ['+e.dt_pedido BETWEEN ? AND ?', 'e.rowid > ?'];
  const valores = [de, ate, Number(p.get('apos_id')) || 0];
  const seller = p.get('seller');
  if (seller) {
    filtros.push('e.n_fornecedor = ?');
    valores.push(seller);
  }
  // Só entram as combinações transportadora × seller de REGRAS_RELATORIO ("Todas" = todas as regras)
  const transportadora = p.get('transportadora');
  const regras = transportadora ? REGRAS_RELATORIO.filter(r => r.valor === transportadora) : REGRAS_RELATORIO;
  if (!regras.length) return erro(400, 'Transportadora não disponível no relatório');
  const regraSql = `(${regras.map(r => `(e.n_fornecedor IN (${r.sellers.map(() => '?').join(', ')}) AND t.transportador LIKE ?)`).join(' OR ')})`;
  const regraValores = regras.flatMap(r => [...r.sellers, r.padrao]);
  // Transportadora e CT-e: só os itens da NF que passam na regra (uma NF pode ter itens de transportadoras
  // diferentes), pelo índice idx_tracking_nf. Uma NF da Vitrola tem dezenas de itens, então os itens são lidos
  // UMA vez por pedido: a mesma subconsulta traz "transportador␟cte" (separados aqui) e decide se o pedido entra
  // (_tc nulo = nenhum item da regra). Com EXISTS + uma subconsulta por coluna, as leituras triplicavam.
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT e.rowid AS _id,
              e.pedido_compra, e.pedido, e.ordem, e.n_fornecedor, e.fornecedor, e.nome_forn, e.centro, e.centro_expedicao,
              e.dt_pedido, e.dt_liberacao, e.nota_fiscal_explode, e.emissao, e.data_coleta, e.emissao_cte, e.data_embarque,
              e.data_entrega, e.dt_faturamento, e.nf, e.dt_entrega, e.no_prazo, e.cidade, e.bairro, e.zona, e.uf,
              e.documento_compras, e.numero_documento_nove_posicoes, e.origem,
              (SELECT group_concat(DISTINCT t.transportador || char(31) || IFNULL(t.cte, '')) FROM tracking_aereo t
               WHERE t.nota_fiscal_explode = e.nota_fiscal_explode AND ${regraSql}) AS _tc
       FROM entregas_mkt e
       WHERE ${filtros.join(' AND ')}
       ORDER BY e.rowid
     ) WHERE _tc IS NOT NULL LIMIT ?`
  ).bind(...regraValores, ...valores, LINHAS_POR_PARTE_RELATORIO).all();

  const itens = (results || []).map(({ _tc, ...linha }) => {
    const pares = _tc.split(',').map(par => par.split('\x1f'));
    linha.transportador = [...new Set(pares.map(([transp]) => transp))].join(', ');
    linha.cte = [...new Set(pares.map(([, cte]) => cte).filter(Boolean))].join(', ');
    return linha;
  });
  return Response.json({
    itens,
    proximo: itens.length === LINHAS_POR_PARTE_RELATORIO ? itens[itens.length - 1]._id : null,
  });
}

// Transportadoras do relatório e para quais sellers cada uma vale (pedido da Emilly, 07/10):
// GRU - KM CARGO só Brascol; LLS só Vitrola e Tramontina; LATAM fica disponível mesmo sem dados no tracking ainda.
// padrao = LIKE em tracking_aereo.transportador; sellers = valores de entregas_mkt.n_fornecedor.
const REGRAS_RELATORIO = [
  { valor: 'GRU', rotulo: 'GRU - KM CARGO (Brascol)', padrao: 'GRU - KM CARGO%', sellers: ['Brascol'] },
  { valor: 'LLS', rotulo: 'LLS TRANSPORTE (Vitrola e Tramontina)', padrao: 'LLS TRANSPORTE%', sellers: ['Vitrola', 'Tramontina'] },
  { valor: 'LATAM', rotulo: 'LATAM', padrao: '%LATAM%', sellers: ['Brascol', 'Vitrola', 'Tramontina'] },
];

function filtrosRelatorio() {
  return Response.json({ transportadoras: REGRAS_RELATORIO.map(({ valor, rotulo }) => ({ valor, rotulo })) });
}

async function listarTracking(env, p) {
  const nf = (p.get('nf') || '').trim();
  if (!/^\d{1,10}$/.test(nf)) return erro(400, 'Informe a NF (só números)');
  const { results } = await env.DB.prepare(
    'SELECT * FROM tracking_aereo WHERE nota_fiscal_explode = ? ORDER BY descricao_material'
  ).bind(nfTracking(nf)).all();
  return Response.json(results || []);
}

function nfTracking(nf) {
  return String(nf).replace(/^0+/, '').padStart(10, '0');
}

async function statusSync(env) {
  const { results } = await env.DB.prepare(
    'SELECT tabela, MAX(executado_em) AS executado_em FROM sync_log GROUP BY tabela'
  ).all();
  return Response.json(results || []);
}

function erro(status, mensagem) {
  return Response.json({ success: false, error: mensagem }, { status });
}
