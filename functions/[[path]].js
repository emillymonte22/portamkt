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
      if (request.method === 'GET') return await listarAgendamentos(env);
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
    if (path === '/api/tracking' && request.method === 'GET') return await listarTracking(env, url.searchParams);
    if (path === '/api/consulta' && request.method === 'GET') return await consultarNf(env, url.searchParams);
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
  if (user && user.senha.startsWith('pbkdf2$')) {
    valido = await verificarSenha(senha, user.senha);
  } else if (user) {
    // Senha ainda em texto puro (cadastro antigo): confere e tenta converter para hash.
    // Se a gravação falhar (ex.: limite diário do D1), o login segue e tenta de novo na próxima vez.
    valido = iguais(senha, user.senha);
    if (valido) {
      try {
        await env.DB.prepare('UPDATE usuarios SET senha = ? WHERE id = ?')
          .bind(await gerarHashSenha(senha), user.id).run();
      } catch (err) {
        console.error('Não foi possível converter a senha para hash', err);
      }
    }
  }
  if (!valido) return erro(401, 'Utilizador ou senha incorretos');

  const sessao = { username: user.username, perfil: user.perfil };
  const token = await assinar({ ...sessao, exp: Math.floor(Date.now() / 1000) + SESSAO_SEGUNDOS }, env.SESSION_SECRET);
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
  return { username: dados.username, perfil: dados.perfil };
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

async function listarAgendamentos(env) {
  const { results } = await env.DB.prepare('SELECT * FROM agendamentos ORDER BY id DESC LIMIT 100').all();
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

  // Paginação por cursor (data + pedido do último item da página anterior): usa o índice
  // idx_entregas_data e lê só as linhas da página, em vez de pular linhas com OFFSET.
  const aposData = p.get('apos_data');
  const aposPedido = Number(p.get('apos_pedido'));
  if (aposData && aposPedido) {
    filtros.push('(dt_pedido, pedido) < (?, ?)');
    valores.push(aposData, aposPedido);
  }

  if (!busca) return Response.json(await paginaEntregas(env, filtros, valores));

  // Busca por número de NF, pedido ou ordem (aceita digitar com pontos, traços etc.)
  const numero = busca.replace(/\D/g, '');
  if (!numero || numero.length > 18) return erro(400, 'Busque por número de NF, pedido ou ordem');

  // 1º: número exato, usando os índices (leve)
  const n = Number(numero);
  const exata = await paginaEntregas(env,
    [...filtros, '(nf = ? OR pedido = ? OR ordem = ? OR nota_fiscal_explode = ?)'],
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
  filtrosParcial.push('(CAST(pedido AS TEXT) LIKE ? OR CAST(ordem AS TEXT) LIKE ? OR CAST(nf AS TEXT) LIKE ? OR nota_fiscal_explode LIKE ?)');
  valoresParcial.push(contem, contem, contem, contem);
  return Response.json(await paginaEntregas(env, filtrosParcial, valoresParcial));
}

// Busca até 3x o tamanho da página e junta as linhas repetidas do mesmo pedido
// (elas vêm lado a lado por causa da ordenação), sem GROUP BY, que obrigaria a ler tudo.
async function paginaEntregas(env, filtros, valores) {
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
  const limite = ITENS_POR_PAGINA * 3;
  const { results } = await env.DB.prepare(
    `SELECT * FROM entregas_mkt ${where} ORDER BY dt_pedido DESC, pedido DESC LIMIT ?`
  ).bind(...valores, limite).all();

  const linhas = results || [];
  const itens = [];
  for (const linha of linhas) {
    const anterior = itens[itens.length - 1];
    if (anterior && linha.pedido !== null && anterior.pedido === linha.pedido) continue;
    itens.push(linha);
  }
  const pagina = itens.slice(0, ITENS_POR_PAGINA);
  const ultimo = pagina[pagina.length - 1];
  return {
    itens: pagina,
    tem_mais: itens.length > ITENS_POR_PAGINA || linhas.length === limite,
    proximo: ultimo ? { apos_data: ultimo.dt_pedido, apos_pedido: ultimo.pedido } : null,
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

async function listarTracking(env, p) {
  const nf = (p.get('nf') || '').trim();
  if (!/^\d{1,10}$/.test(nf)) return erro(400, 'Informe a NF (só números)');
  const { results } = await env.DB.prepare(
    'SELECT * FROM tracking_aereo WHERE nota_fiscal_explode = ? ORDER BY descricao_material'
  ).bind(nfTracking(nf)).all();
  return Response.json(results || []);
}

// Consulta de uma NF juntando as três fontes: tracking (coleta/CT-e/embarque/entrega no CD),
// pedido do marketplace (faturamento e entrega ao cliente) e a coleta LATAM incluída no portal.
async function consultarNf(env, p) {
  const numero = (p.get('nf') || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!numero || numero.length > 10) return erro(400, 'Informe a NF (só números)');

  const [tracking, entrega, coleta] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM tracking_aereo WHERE nota_fiscal_explode = ? LIMIT 1').bind(nfTracking(numero)),
    env.DB.prepare(
      `SELECT pedido, n_fornecedor, dt_faturamento, dt_entrega, no_prazo, nf
       FROM entregas_mkt WHERE nota_fiscal_explode = ? ORDER BY dt_entrega DESC, dt_faturamento DESC LIMIT 1`
    ).bind(nfTracking(numero)),
    // agendamentos.nota_fiscal guarda várias NFs separadas por "/" (tabela pequena)
    env.DB.prepare(`SELECT * FROM agendamentos WHERE '/' || nota_fiscal || '/' LIKE ? ORDER BY id DESC LIMIT 1`)
      .bind(`%/${numero}/%`),
  ]);

  return Response.json({
    tracking: tracking.results[0] || null,
    entrega: entrega.results[0] || null,
    coleta: coleta.results[0] || null,
  });
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
