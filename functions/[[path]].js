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
        if (!['admin', 'cd'].includes(usuario.perfil)) return erro(403, 'Sem permissão');
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
    // Senha ainda em texto puro (cadastro antigo): confere e já converte para hash
    valido = iguais(senha, user.senha);
    if (valido) {
      await env.DB.prepare('UPDATE usuarios SET senha = ? WHERE id = ?')
        .bind(await gerarHashSenha(senha), user.id).run();
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

// Comparação em tempo constante, para não vazar informação pelo tempo de resposta
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
  const obrigatorios = ['seller', 'transportadora', 'motorista', 'veiculo_placa', 'nota_fiscal', 'tipo_carga', 'data_agendamento'];
  if (obrigatorios.some(c => typeof b[c] !== 'string' || !b[c].trim())) {
    return erro(400, `Campos obrigatórios: ${obrigatorios.join(', ')}`);
  }
  await env.DB.prepare(
    `INSERT INTO agendamentos (seller, transportadora, motorista, veiculo_placa, nota_fiscal, tipo_carga, data_agendamento, status_etapa)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(b.seller, b.transportadora, b.motorista, b.veiculo_placa, b.nota_fiscal, b.tipo_carga, b.data_agendamento,
    b.status_etapa || 'Emissão do Pedido').run();
  return Response.json({ success: true });
}

async function alterarLiberacaoLatam(request, env, id) {
  const { liberado_latam } = await request.json().catch(() => ({}));
  if (typeof liberado_latam !== 'boolean') return erro(400, 'liberado_latam deve ser true ou false');
  const { meta } = await env.DB.prepare('UPDATE agendamentos SET liberado_latam = ? WHERE id = ?')
    .bind(liberado_latam ? 1 : 0, id).run();
  if (!meta.changes) return erro(404, 'Agendamento não encontrado');
  return Response.json({ success: true });
}

// ---------- Dados do Databricks (copiados pelo Job databricks/sync_d1.py) ----------

async function listarEntregas(env, p) {
  const filtros = [];
  const valores = [];
  const filtrar = (sql, valor) => { if (valor) { filtros.push(sql); valores.push(valor); } };

  filtrar('n_fornecedor = ?', p.get('seller'));
  filtrar('no_prazo = ?', p.get('status'));
  filtrar('dt_pedido >= ?', p.get('de'));
  filtrar('dt_pedido <= ?', p.get('ate'));
  const busca = (p.get('busca') || '').trim();
  if (/^\d{1,18}$/.test(busca)) {
    // Um número pode ser NF, pedido ou ordem; a NF do tracking tem 10 dígitos com zeros à esquerda
    const n = Number(busca);
    filtros.push('(nf = ? OR pedido = ? OR ordem = ? OR nota_fiscal_explode = ?)');
    valores.push(n, n, n, nfTracking(busca));
  } else if (busca) {
    return erro(400, 'Busque por número de NF, pedido ou ordem');
  }

  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
  const pagina = Math.max(1, parseInt(p.get('pagina'), 10) || 1);

  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM entregas_mkt ${where}`).bind(...valores).first('n');
  const { results } = await env.DB.prepare(
    `SELECT * FROM entregas_mkt ${where} ORDER BY dt_pedido DESC, pedido DESC LIMIT ? OFFSET ?`
  ).bind(...valores, ITENS_POR_PAGINA, (pagina - 1) * ITENS_POR_PAGINA).all();

  return Response.json({ itens: results, total, pagina, por_pagina: ITENS_POR_PAGINA });
}

async function filtrosEntregas(env) {
  const [sellers, status] = await env.DB.batch([
    env.DB.prepare('SELECT DISTINCT n_fornecedor AS v FROM entregas_mkt WHERE n_fornecedor IS NOT NULL ORDER BY 1'),
    env.DB.prepare('SELECT DISTINCT no_prazo AS v FROM entregas_mkt WHERE no_prazo IS NOT NULL ORDER BY 1'),
  ]);
  return Response.json({ sellers: sellers.results.map(r => r.v), status: status.results.map(r => r.v) });
}

async function listarTracking(env, p) {
  const nf = (p.get('nf') || '').trim();
  if (!/^\d{1,10}$/.test(nf)) return erro(400, 'Informe a NF (só números)');
  const { results } = await env.DB.prepare(
    'SELECT * FROM tracking_aereo WHERE nota_fiscal_explode = ? ORDER BY descricao_material'
  ).bind(nfTracking(nf)).all();
  return Response.json(results);
}

function nfTracking(nf) {
  return String(nf).replace(/^0+/, '').padStart(10, '0');
}

async function statusSync(env) {
  const { results } = await env.DB.prepare(
    'SELECT tabela, MAX(executado_em) AS executado_em FROM sync_log GROUP BY tabela'
  ).all();
  return Response.json(results);
}

function erro(status, mensagem) {
  return Response.json({ success: false, error: mensagem }, { status });
}
