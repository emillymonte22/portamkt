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
        // A lista geral de inclusão (card "Inclusão de Coletas") é só do admin (pedido da Emilly em 08/10);
        // o CD vê as liberadas na aba Disponível para Coleta e todos veem "Cargas em Trânsito"
        if (escopo === '' && usuario.perfil !== 'admin') return erro(403, 'Apenas o administrador');
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

    // Sinalizador do CD01: aviso de coleta nova, confirmação pelo CD e coletas sugeridas pela planilha
    if (path === '/api/agendamentos/novas' && request.method === 'GET') {
      if (!['cd', 'admin'].includes(usuario.perfil)) return erro(403, 'Apenas CD e administrador');
      return await contarNovas(env);
    }
    if (path === '/api/agendamentos/visto' && request.method === 'POST') {
      // Só o próprio CD "vê" a coleta; o admin abrindo a aba não apaga o aviso do CD
      if (usuario.perfil !== 'cd') return Response.json({ success: true, marcadas: 0 });
      return await marcarVistas(env);
    }
    const confirmacao = path.match(/^\/api\/agendamentos\/(\d+)\/cd$/);
    if (confirmacao && request.method === 'PATCH') {
      if (!['cd', 'admin'].includes(usuario.perfil)) return erro(403, 'Apenas CD e administrador');
      return await confirmarNoCd(request, env, Number(confirmacao[1]), usuario.username);
    }
    if (path === '/api/agendamentos/sugestao' && request.method === 'GET') {
      if (usuario.perfil !== 'admin') return erro(403, 'Apenas o administrador');
      return await sugestaoPorNotas(env, url.searchParams.get('nf') || '');
    }
    if (path === '/api/agendamentos/planilha') {
      if (usuario.perfil !== 'admin') return erro(403, 'Apenas o administrador');
      if (request.method === 'GET') return await coletasDaPlanilha(env);
      if (request.method === 'POST') return await liberarDaPlanilha(request, env);
    }

    if (path === '/api/coletas/transito' && request.method === 'GET') return await cargasEmTransito(env);
    if (path === '/api/indicadores/coletas' && request.method === 'GET') return await resumoColetas(env, url.searchParams);
    if (path === '/api/entregas' && request.method === 'GET') return await listarEntregas(env, url.searchParams);
    if (path === '/api/entregas/filtros' && request.method === 'GET') return await filtrosEntregas(env);
    if (path === '/api/indicadores' && request.method === 'GET') return await indicadores(env, url.searchParams);
    if (path === '/api/indicadores/leadtime' && request.method === 'GET') return await leadTimeSemanal(env, url.searchParams);    if (path === '/api/relatorio' && request.method === 'GET') return await relatorio(env, url.searchParams);
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

// Consultas: últimos 100. CD: todas as coletas LATAM liberadas (novas primeiro, recebidas por último).
// Admin: todas as LATAM, bloqueadas primeiro. A tabela é pequena; o LIMIT é só uma proteção (regra 12).
const ORDEM_CD = `CASE WHEN visto_cd_em IS NULL THEN 0 WHEN status_cd = 'recebido' THEN 3 WHEN status_cd = 'coletado' THEN 2 ELSE 1 END`;
const SQL_AGENDAMENTOS = {
  '': 'SELECT * FROM agendamentos ORDER BY id DESC LIMIT 100',
  cd: `SELECT * FROM agendamentos WHERE UPPER(transportadora) = 'LATAM' AND liberado_latam = 1
       ORDER BY ${ORDEM_CD}, COALESCE(liberado_em, criado_em) DESC LIMIT 1000`,
  admin: `SELECT * FROM agendamentos WHERE UPPER(transportadora) = 'LATAM' ORDER BY liberado_latam, ${ORDEM_CD}, id DESC LIMIT 1000`,
};

async function listarAgendamentos(env, escopo) {
  const sql = SQL_AGENDAMENTOS[escopo];
  if (!sql) return erro(400, 'escopo inválido');
  const { results } = await env.DB.prepare(sql).all();
  const coletas = results || [];
  if (escopo) await anexarAgendaPlanilha(env, coletas);
  return Response.json(coletas);
}

// Confirmação pela planilha (pedido da Emilly, 09/10): quando o CD marca "Recebido no CD", a tela mostra a data do
// recebimento em Entrega CD; no dia seguinte, a planilha CONTROLE_AÉREO traz a AGENDA CD e confirma. Aqui cada coleta
// ganha planilha_agenda_cd: pelo Nº da coleta (coletas_planilha) ou, sem ele, pelas NFs (base geral, índice de NF).
async function anexarAgendaPlanilha(env, coletas) {
  if (!coletas.length) return;
  const porColeta = new Map();
  const comNumero = [...new Set(coletas.map(c => c.ncoleta).filter(Boolean))];
  const nfs = [...new Set(coletas.filter(c => !c.ncoleta)
    .flatMap(c => String(c.nota_fiscal || '').split('/').filter(Boolean).map(nfTracking)))];
  const consultas = [];
  for (let i = 0; i < comNumero.length; i += 90) {
    const lote = comNumero.slice(i, i + 90);
    consultas.push(env.DB.prepare(
      `SELECT ncoleta AS chave, MAX(agenda_cd) AS agenda_cd FROM coletas_planilha
       WHERE ncoleta IN (${lote.map(() => '?').join(', ')}) GROUP BY ncoleta`).bind(...lote));
  }
  if (nfs.length && await tabelaPedidos(env) === 'base_geral') {
    for (let i = 0; i < nfs.length; i += 90) {
      const lote = nfs.slice(i, i + 90);
      consultas.push(env.DB.prepare(
        `SELECT nota_fiscal_explode AS chave, MAX(pl_agenda_cd) AS agenda_cd FROM base_geral
         WHERE nota_fiscal_explode IN (${lote.map(() => '?').join(', ')}) GROUP BY nota_fiscal_explode`).bind(...lote));
    }
  }
  if (!consultas.length) return;
  for (const { results } of await env.DB.batch(consultas)) {
    for (const r of results || []) if (r.agenda_cd) porColeta.set(String(r.chave), r.agenda_cd);
  }
  for (const c of coletas) {
    const datas = c.ncoleta
      ? [porColeta.get(String(c.ncoleta))]
      : String(c.nota_fiscal || '').split('/').filter(Boolean).map(n => porColeta.get(nfTracking(n)));
    c.planilha_agenda_cd = datas.filter(Boolean).sort().pop() || null;
  }
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

  // Nº da coleta da planilha (vem do preenchimento automático): não deixa incluir a mesma coleta duas vezes
  const ncoleta = String(b.ncoleta || '').replace(/\D/g, '').slice(0, 20) || null;
  if (ncoleta && await env.DB.prepare('SELECT 1 FROM agendamentos WHERE ncoleta = ? LIMIT 1').bind(ncoleta).first()) {
    return erro(409, `A coleta ${ncoleta} da planilha já foi incluída`);
  }

  // A coleta nasce bloqueada: o admin libera depois pelo Painel Admin, avisando o CD
  await env.DB.prepare(
    `INSERT INTO agendamentos (seller, transportadora, nota_fiscal, cte, data_coleta, data_cte, entrega_cd, status_etapa,
                               liberado_latam, origem, ncoleta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'manual', ?)`
  ).bind(
    b.seller.trim(),
    b.transportadora.trim(),
    notas,
    String(b.cte || '').trim().slice(0, 200),
    datas.data_coleta,
    datas.data_cte,
    datas.entrega_cd,
    String(b.status_etapa || 'Emissão do Pedido').slice(0, 60),
    ncoleta,
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
  // Liberar marca a hora e deixa a coleta como NOVA para o CD (visto_cd_em = NULL)
  const { meta } = await env.DB.prepare(
    'UPDATE agendamentos SET liberado_latam = ?, liberado_em = ?, visto_cd_em = NULL WHERE id = ?'
  ).bind(liberado_latam ? 1 : 0, liberado_latam ? agoraIso() : null, id).run();
  if (!meta.changes) return erro(404, 'Agendamento não encontrado');
  return Response.json({ success: true });
}

const agoraIso = () => new Date().toISOString();
const SQL_LATAM_LIBERADAS = `UPPER(transportadora) = 'LATAM' AND liberado_latam = 1`;

// ---------- Sinalizador do CD01 ----------

// Aviso de coleta nova: quantas coletas liberadas o CD ainda não viu (contador no menu; tabela pequena)
async function contarNovas(env) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS novas FROM agendamentos WHERE ${SQL_LATAM_LIBERADAS} AND visto_cd_em IS NULL`
  ).first();
  return Response.json({ novas: r?.novas || 0 });
}

// O CD abriu a aba: as coletas liberadas deixam de ser NOVAS (a tela já recebeu a lista com o destaque)
async function marcarVistas(env) {
  const { meta } = await env.DB.prepare(
    `UPDATE agendamentos SET visto_cd_em = ? WHERE ${SQL_LATAM_LIBERADAS} AND visto_cd_em IS NULL`
  ).bind(agoraIso()).run();
  return Response.json({ success: true, marcadas: meta.changes || 0 });
}

// CD confirma: pendente → coletado → recebido no CD; "desfazer" volta um passo
async function confirmarNoCd(request, env, id, usuario) {
  const { acao } = await request.json().catch(() => ({}));
  if (!['coletado', 'recebido', 'desfazer'].includes(acao)) return erro(400, 'acao deve ser coletado, recebido ou desfazer');
  const atual = await env.DB.prepare(
    `SELECT status_cd, coletado_em FROM agendamentos WHERE id = ? AND ${SQL_LATAM_LIBERADAS}`
  ).bind(id).first();
  if (!atual) return erro(404, 'Coleta não encontrada ou não liberada para o CD');

  const status = atual.status_cd || 'pendente';
  const agora = agoraIso();
  let sql;
  let valores;
  if (acao === 'coletado') {
    if (status !== 'pendente') return erro(409, 'Esta coleta já foi confirmada');
    sql = `status_cd = 'coletado', coletado_em = ?, confirmado_por = ?`;
    valores = [agora, usuario];
  } else if (acao === 'recebido') {
    if (status === 'recebido') return erro(409, 'Esta coleta já foi recebida no CD');
    sql = `status_cd = 'recebido', coletado_em = COALESCE(coletado_em, ?), recebido_em = ?, confirmado_por = ?`;
    valores = [agora, agora, usuario];
  } else if (status === 'recebido') {
    sql = `status_cd = 'coletado', recebido_em = NULL, confirmado_por = ?`;
    valores = [usuario];
  } else if (status === 'coletado') {
    sql = `status_cd = 'pendente', coletado_em = NULL, confirmado_por = ?`;
    valores = [usuario];
  } else {
    return erro(409, 'Nada para desfazer');
  }
  await env.DB.prepare(`UPDATE agendamentos SET ${sql} WHERE id = ?`).bind(...valores, id).run();
  return Response.json({ success: true });
}

// Preencher pela planilha: dadas as NFs digitadas na inclusão, busca na base geral (manifest + tracking + planilha)
// o seller, a transportadora, o CT-e, as datas e o Nº da coleta. Pelo índice de NF; se nada, pela NF de 9 posições.
async function sugestaoPorNotas(env, texto) {
  const notas = normalizarNotas(texto).split('/').filter(Boolean).slice(0, 90);
  if (!notas.length) return erro(400, 'Informe ao menos uma NF');
  if (await tabelaPedidos(env) !== 'base_geral') return Response.json({ encontradas: 0, total: notas.length });

  const colunas = `nota_fiscal_explode, numero_documento_nove_posicoes, n_fornecedor, transportadora, cte, data_coleta,
                   emissao_cte, data_entrega, pl_ncoleta, pl_transportadora, pl_cte, pl_status`;
  const marcas = notas.map(() => '?').join(', ');
  let { results } = await env.DB.prepare(
    `SELECT ${colunas} FROM base_geral WHERE nota_fiscal_explode IN (${marcas}) LIMIT 500`
  ).bind(...notas.map(nfTracking)).all();
  if (!results?.length) {
    ({ results } = await env.DB.prepare(
      `SELECT ${colunas} FROM base_geral
       WHERE numero_documento_nove_posicoes <> '' AND CAST(numero_documento_nove_posicoes AS INTEGER) IN (${marcas}) LIMIT 500`
    ).bind(...notas.map(Number)).all());
  }
  const linhas = results || [];
  const primeiro = campo => linhas.map(l => l[campo]).find(v => v !== null && v !== undefined && String(v).trim() !== '') ?? null;
  const achadas = new Set(linhas.map(l => String(l.nota_fiscal_explode || l.numero_documento_nove_posicoes || '').replace(/^0+/, '')));
  return Response.json({
    total: notas.length,
    encontradas: notas.filter(n => achadas.has(n)).length,
    seller: primeiro('n_fornecedor'),
    transportadora: primeiro('pl_transportadora') || primeiro('transportadora'),
    cte: primeiro('cte') || primeiro('pl_cte'),
    data_coleta: primeiro('data_coleta'),
    data_cte: primeiro('emissao_cte'),
    entrega_cd: primeiro('data_entrega'),
    ncoleta: primeiro('pl_ncoleta'),
    status_planilha: primeiro('pl_status'),
  });
}

// Sinalizar direto da base: coletas LATAM da planilha ainda a caminho (TRANSITO, PROGRAMADO, AGENDADO, SEFAZ)
// que ainda não estão no portal. Lê a base geral inteira (~18 mil linhas): cache de 5 min, zerado ao liberar.
// Mesma lista do notebook "aereo markt" da Emilly (Cargas em Trânsito)
const STATUS_A_CAMINHO = ['TRANSITO', 'PROGRAMADO', 'EM ROTA CD', 'AGENDADO', 'SEFAZ'];
let cachePlanilhaLatam = null;

async function buscarColetasPlanilha(env, ncoleta = null) {
  const { results } = await env.DB.prepare(
    `SELECT pl_ncoleta AS ncoleta, MAX(n_fornecedor) AS seller,
            group_concat(DISTINCT CAST(COALESCE(nota_fiscal_explode, numero_documento_nove_posicoes) AS INTEGER)) AS notas,
            MAX(pl_cte) AS cte, MAX(data_coleta) AS data_coleta, MAX(emissao_cte) AS data_cte,
            MAX(data_entrega) AS entrega_cd, MAX(pl_previsao_entrega) AS previsao_entrega,
            MAX(UPPER(TRIM(pl_status))) AS status_planilha, COUNT(*) AS pedidos
     FROM base_geral
     WHERE UPPER(pl_transportadora) LIKE '%LATAM%' AND pl_ncoleta IS NOT NULL
       AND UPPER(TRIM(pl_status)) IN (${STATUS_A_CAMINHO.map(() => '?').join(', ')})
       ${ncoleta ? 'AND pl_ncoleta = ?' : ''}
       AND pl_ncoleta NOT IN (SELECT ncoleta FROM agendamentos WHERE ncoleta IS NOT NULL)
     GROUP BY pl_ncoleta ORDER BY MAX(data_coleta) DESC LIMIT 100`
  ).bind(...STATUS_A_CAMINHO, ...(ncoleta ? [ncoleta] : [])).all();
  return (results || []).map(c => ({ ...c, notas: String(c.notas || '').split(',').filter(Boolean).join('/') }));
}

async function coletasDaPlanilha(env) {
  if (await tabelaPedidos(env) !== 'base_geral') return Response.json([]);
  if (!cachePlanilhaLatam || Date.now() - cachePlanilhaLatam.em > 5 * 60 * 1000) {
    cachePlanilhaLatam = { em: Date.now(), dados: await buscarColetasPlanilha(env) };
  }
  return Response.json(cachePlanilhaLatam.dados);
}

// Liberar uma coleta sugerida: inclui no portal já liberada para o CD (os dados vêm de novo do servidor, não da tela)
async function liberarDaPlanilha(request, env) {
  const { ncoleta } = await request.json().catch(() => ({}));
  const numero = String(ncoleta || '').replace(/\D/g, '');
  if (!numero) return erro(400, 'Informe a coleta');
  const [c] = await buscarColetasPlanilha(env, numero);
  if (!c) return erro(404, 'Coleta não encontrada na planilha, já entregue ou já incluída');
  if (!c.notas) return erro(409, 'A coleta não tem NF na base');
  await env.DB.prepare(
    `INSERT INTO agendamentos (seller, transportadora, nota_fiscal, cte, data_coleta, data_cte, entrega_cd, status_etapa,
                               liberado_latam, liberado_em, origem, ncoleta)
     VALUES (?, 'LATAM', ?, ?, ?, ?, ?, ?, 1, ?, 'planilha', ?)`
  ).bind(c.seller || '—', normalizarNotas(c.notas), String(c.cte || '').slice(0, 200), c.data_coleta, c.data_cte,
    c.entrega_cd, 'Embarcado', agoraIso(), numero).run();
  cachePlanilhaLatam = null;
  return Response.json({ success: true });
}

// ---------- Coletas da planilha (tabela coletas_planilha) ----------
// Mesmas regras do notebook "aereo markt" da Emilly. A tabela é pequena (~460 linhas): lida inteira.

// Cargas em Trânsito: coletas com status a caminho (todos os perfis veem, aba Consultas)
async function cargasEmTransito(env) {
  const [coletas, sync] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ncoleta, fornecedor, transportadora, cte, notas, previsao_entrega, status
       FROM coletas_planilha WHERE status IN (${STATUS_A_CAMINHO.map(() => '?').join(', ')})
       ORDER BY CAST(ncoleta AS INTEGER), linha`
    ).bind(...STATUS_A_CAMINHO),
    env.DB.prepare(`SELECT MAX(executado_em) AS em FROM sync_log WHERE tabela = 'coletas_planilha'`),
  ]);
  return Response.json({ coletas: coletas.results || [], atualizado_em: sync.results?.[0]?.em || null });
}

// Resumo Mensal e Resumo por Origem das coletas (Indicadores), com o filtro geral da aba:
//   uma linha por coleta (a primeira de cada Nº de coleta + data da coleta, como o drop_duplicates do notebook),
//   mês = mês da DATA DA COLETA, COLETAS = Nº de coletas distintas, VALOR TOTAL = soma do VALOR DA NOTA,
//   Lead Time Coleta x CD = média da coluna LEAD TIME da planilha; por origem = só o mês mais recente.
// Mais a coluna pedida pela Emilly: Lead Time Pedido x Entrega Cliente (média por mês do pedido, base geral).
const SELLER_NA_PLANILHA = { Brascol: ['BRASCOL', 'ONESHOP'], Vitrola: ['VITROLA'], Tramontina: ['TRAMONTINA'] };
const cacheResumoColetas = new Map();

async function resumoColetas(env, p) {
  const ano = new Date().getFullYear();
  const de = p.get('de') || `${ano}-01-01`;
  const ate = p.get('ate') || `${ano}-12-31`;
  if (![de, ate].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) return erro(400, 'Datas inválidas');
  if (de > ate) return erro(400, 'A data inicial é maior que a final');
  const seller = p.get('seller') || '';
  const tabela = await tabelaPedidos(env);

  const chave = JSON.stringify([tabela, de, ate, seller]);
  const guardado = cacheResumoColetas.get(chave);
  if (guardado && Date.now() - guardado.em < CACHE_FILTROS_MS) return Response.json(guardado.dados);

  const filtrosColeta = ['data_coleta BETWEEN ? AND ?'];
  const valoresColeta = [de, ate];
  if (seller) {
    const nomes = SELLER_NA_PLANILHA[seller] || [seller.toUpperCase()];
    filtrosColeta.push(`(${nomes.map(() => 'UPPER(fornecedor) LIKE ?').join(' OR ')})`);
    valoresColeta.push(...nomes.map(n => `%${n}%`));
  }
  const base = `WITH base AS (
      SELECT * FROM (
        SELECT c.*, ROW_NUMBER() OVER (PARTITION BY ncoleta, data_coleta ORDER BY linha) AS rn
        FROM coletas_planilha c WHERE ${filtrosColeta.join(' AND ')}
      ) WHERE rn = 1
    )`;
  const filtrosPedido = ['dt_pedido BETWEEN ? AND ?', 'pedido IS NOT NULL'];
  const valoresPedido = [de, ate];
  if (seller) { filtrosPedido.push('n_fornecedor = ?'); valoresPedido.push(seller); }

  const [mensal, origem, pedidos] = await env.DB.batch([
    env.DB.prepare(
      `${base} SELECT substr(data_coleta, 1, 7) AS mes, COUNT(DISTINCT ncoleta) AS coletas,
              SUM(valor_nota) AS valor_total, AVG(lead_time) AS lead_time
       FROM base GROUP BY mes ORDER BY mes`
    ).bind(...valoresColeta),
    env.DB.prepare(
      `${base} SELECT origem, COUNT(DISTINCT ncoleta) AS coletas, SUM(valor_nota) AS valor_total, AVG(lead_time) AS lead_time,
              (SELECT MAX(substr(data_coleta, 1, 7)) FROM base) AS mes
       FROM base WHERE substr(data_coleta, 1, 7) = (SELECT MAX(substr(data_coleta, 1, 7)) FROM base)
       GROUP BY origem ORDER BY origem`
    ).bind(...valoresColeta),
    env.DB.prepare(
      `WITH p AS (
         SELECT pedido, MAX(dt_pedido) AS dt_pedido, julianday(MAX(dt_entrega)) - julianday(MAX(dt_pedido)) AS dias
         FROM ${tabela} WHERE ${filtrosPedido.join(' AND ')} GROUP BY pedido
       )
       SELECT substr(dt_pedido, 1, 7) AS mes, AVG(CASE WHEN dias >= 0 THEN dias END) AS lead_time_cliente,
              COUNT(CASE WHEN dias >= 0 THEN 1 END) AS pedidos
       FROM p GROUP BY mes`
    ).bind(...valoresPedido),
  ]);

  const porMesPedido = new Map((pedidos.results || []).map(r => [r.mes, r]));
  const meses = (mensal.results || []).map(m => ({
    ...m,
    lead_time_cliente: porMesPedido.get(m.mes)?.lead_time_cliente ?? null,
    pedidos_cliente: porMesPedido.get(m.mes)?.pedidos ?? 0,
  }));
  const linhasOrigem = origem.results || [];
  const dados = { de, ate, seller, mensal: meses, origem: linhasOrigem, mes_origem: linhasOrigem[0]?.mes || null };
  if (cacheResumoColetas.size > 50) cacheResumoColetas.clear();
  cacheResumoColetas.set(chave, { em: Date.now(), dados });
  return Response.json(dados);
}

// ---------- Dados do Databricks ----------

// Base geral (decisão da Emilly, 07/10): o Job junta as 3 bases — manifest da BOL, tracking aéreo e a planilha
// CONTROLE_AÉREO — por NF do seller + seller e grava a tabela base_geral (uma linha por linha do manifest, datas,
// CT-e e transportadora já unificados). O portal lê só ela. Até a 1ª carga terminar (registrada em sync_log),
// usa entregas_mkt, só com os dados do manifest. Conferido a cada 10 min (1 linha lida).
let cacheTabela = null;

async function tabelaPedidos(env) {
  if (!cacheTabela || Date.now() - cacheTabela.em > 10 * 60 * 1000) {
    const pronta = await env.DB.prepare(`SELECT 1 FROM sync_log WHERE tabela = 'base_geral' LIMIT 1`).first();
    cacheTabela = { em: Date.now(), nome: pronta ? 'base_geral' : 'entregas_mkt' };
  }
  return cacheTabela.nome;
}

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

  // Paginação por cursor (data + pedido de compra do último item da página anterior): usa o índice de
  // (dt_pedido, pedido_compra) e lê só as linhas da página, em vez de pular linhas com OFFSET.
  const aposData = p.get('apos_data');
  const aposPedidoCompra = Number(p.get('apos_pedido_compra'));
  if (aposData && aposPedidoCompra) {
    filtros.push('(dt_pedido, pedido_compra) < (?, ?)');
    valores.push(aposData, aposPedidoCompra);
  }

  const tabela = await tabelaPedidos(env);
  if (!busca) return Response.json(await paginaEntregas(env, tabela, filtros, valores));

  // Busca por número de NF, pedido de compra ou ordem (aceita digitar com pontos, traços etc.)
  const numero = busca.replace(/\D/g, '');
  if (!numero || numero.length > 18) return erro(400, 'Busque por número de NF, pedido de compra ou ordem');

  // 1º: número exato nas colunas com índice (pedido de compra e NF do seller): leve
  const n = Number(numero);
  const indexada = await paginaEntregas(env, tabela,
    [...filtros, '(pedido_compra = ? OR nota_fiscal_explode = ?)'], [...valores, n, nfTracking(numero)]);
  if (indexada.itens.length || aposData) return Response.json(indexada);

  // 2º: número exato na NF Bemol, na ordem e na NF do seller de 9 posições (sem índice: lê a tabela, ~18 mil
  // linhas). A NF do seller vem vazia em pedidos sem tracking (ex.: LATAM), mas numero_documento_nove_posicoes a tem.
  const exata = await paginaEntregas(env, tabela,
    [...filtros, "(nf = ? OR ordem = ? OR (numero_documento_nove_posicoes <> '' AND CAST(numero_documento_nove_posicoes AS INTEGER) = ?))"],
    [...valores, n, n, n]);
  if (exata.itens.length || numero.length < 4) return Response.json(exata);

  // 3º: nada exato → busca parcial ("contém"), limitada ao período (ano corrente se não informado)
  const filtrosParcial = [...filtros];
  const valoresParcial = [...valores];
  if (!p.get('de') && !p.get('ate')) {
    filtrosParcial.push('dt_pedido BETWEEN ? AND ?');
    valoresParcial.push(`${ano}-01-01`, `${ano}-12-31`);
  }
  const contem = `%${numero}%`;
  filtrosParcial.push('(CAST(pedido_compra AS TEXT) LIKE ? OR CAST(ordem AS TEXT) LIKE ? OR CAST(nf AS TEXT) LIKE ? OR nota_fiscal_explode LIKE ?)');
  valoresParcial.push(contem, contem, contem, contem);
  return Response.json(await paginaEntregas(env, tabela, filtrosParcial, valoresParcial));
}

// Busca até 3x o tamanho da página e junta as linhas repetidas do mesmo pedido de compra
// (elas vêm lado a lado por causa da ordenação), sem GROUP BY, que obrigaria a ler tudo.
async function paginaEntregas(env, tabela, filtros, valores) {
  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
  const limite = ITENS_POR_PAGINA * 3;
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${tabela} ${where} ORDER BY dt_pedido DESC, pedido_compra DESC LIMIT ?`
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
    const tabela = await tabelaPedidos(env);
    const [sellers, status] = await env.DB.batch([
      env.DB.prepare(`SELECT DISTINCT n_fornecedor AS v FROM ${tabela} WHERE n_fornecedor IS NOT NULL ORDER BY 1`),
      env.DB.prepare(`SELECT DISTINCT no_prazo AS v FROM ${tabela} WHERE no_prazo IS NOT NULL ORDER BY 1`),
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

  const tabela = await tabelaPedidos(env);
  const chave = JSON.stringify([tabela, de, ate, seller]);
  const guardado = cacheIndicadores.get(chave);
  if (guardado && Date.now() - guardado.em < CACHE_FILTROS_MS) return Response.json(guardado.dados);

  const filtros = ['dt_pedido BETWEEN ? AND ?', 'pedido IS NOT NULL'];
  const valores = [de, ate];
  if (seller) {
    filtros.push('n_fornecedor = ?');
    valores.push(seller);
  }

  // Prazos em dias só contam quando as duas datas existem e a diferença não é negativa.
  // d_pcd = pedido → Entrega CD (pedido da Emilly em 08/10; antes era pedido → faturamento CD)
  const { results } = await env.DB.prepare(
    `WITH base AS (
       SELECT pedido,
              MAX(n_fornecedor) AS seller, MAX(dt_pedido) AS dt_pedido, UPPER(TRIM(MAX(no_prazo))) AS status,
              julianday(MAX(data_entrega))   - julianday(MAX(dt_pedido)) AS d_pcd,
              julianday(MAX(dt_entrega))     - julianday(MAX(dt_pedido)) AS d_ent,
              julianday(MAX(data_entrega))   - julianday(MAX(data_coleta)) AS d_cd
       FROM ${tabela} WHERE ${filtros.join(' AND ')}
       GROUP BY pedido
     )
     SELECT seller, substr(dt_pedido, 1, 7) AS mes, COUNT(*) AS pedidos,
            SUM(status = 'NO PRAZO') AS no_prazo,
            SUM(status = 'FORA DO PRAZO') AS fora_prazo,
            SUM(status = 'SEM ENTREGA') AS sem_entrega,
            SUM(CASE WHEN d_pcd >= 0 THEN d_pcd END) AS soma_pcd, COUNT(CASE WHEN d_pcd >= 0 THEN 1 END) AS n_pcd,
            SUM(CASE WHEN d_ent >= 0 THEN d_ent END) AS soma_ent, COUNT(CASE WHEN d_ent >= 0 THEN 1 END) AS n_ent,
            SUM(CASE WHEN d_cd  >= 0 THEN d_cd  END) AS soma_cd,  COUNT(CASE WHEN d_cd  >= 0 THEN 1 END) AS n_cd
     FROM base GROUP BY seller, mes ORDER BY mes, seller`
  ).bind(...valores).all();

  const dados = { de, ate, seller, grupos: results || [] };
  if (cacheIndicadores.size > 50) cacheIndicadores.clear();
  cacheIndicadores.set(chave, { em: Date.now(), dados });
  return Response.json(dados);
}

// Lead time semanal: média de dias de cada etapa por semana (segunda a domingo) da data do pedido,
// nas SEMANAS_LEAD_TIME semanas que terminam na semana de "ate" (padrão: hoje). Lê só os pedidos dessas
// semanas (índice de data). Cada pedido conta uma vez; uma etapa só entra na média quando as duas datas
// existem e a diferença não é negativa. Total = pedido → entrega ao cliente (ponta a ponta).
const SEMANAS_LEAD_TIME = 6;
const ETAPAS_LEAD_TIME = [
  ['pedido_nf', 'dt_pedido', 'emissao'],
  ['nf_cte', 'emissao', 'emissao_cte'],
  ['cte_embarque', 'emissao_cte', 'data_embarque'],
  ['embarque_cd', 'data_embarque', 'data_entrega'],
  ['cd_faturamento', 'data_entrega', 'dt_faturamento'],
  ['faturamento_cliente', 'dt_faturamento', 'dt_entrega'],
  ['total', 'dt_pedido', 'dt_entrega'],
];
const cacheLeadTime = new Map();

async function leadTimeSemanal(env, p) {
  const fim = p.get('ate') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fim)) return erro(400, 'Data inválida');
  // Segunda-feira da semana de "fim" e da primeira semana mostrada (contas em UTC, só com a data)
  const [a, m, d] = fim.split('-').map(Number);
  const diaFim = Date.UTC(a, m - 1, d);
  const segundaFim = diaFim - ((new Date(diaFim).getUTCDay() + 6) % 7) * 86400000;
  const ultimo = new Date(segundaFim + 6 * 86400000).toISOString().slice(0, 10);
  // "de" (filtro geral da aba): mostra menos semanas se o período for curto, e só pedidos a partir dele
  const de = p.get('de') || '';
  if (de && !/^\d{4}-\d{2}-\d{2}$/.test(de)) return erro(400, 'Data inválida');
  if (de && de > fim) return erro(400, 'A data inicial é maior que a final');
  let semanasMostradas = SEMANAS_LEAD_TIME;
  if (de) {
    const [ad, md, dd] = de.split('-').map(Number);
    const diaDe = Date.UTC(ad, md - 1, dd);
    const segundaDe = diaDe - ((new Date(diaDe).getUTCDay() + 6) % 7) * 86400000;
    semanasMostradas = Math.min(SEMANAS_LEAD_TIME, Math.round((segundaFim - segundaDe) / (7 * 86400000)) + 1);
  }
  const inicio = new Date(segundaFim - (semanasMostradas - 1) * 7 * 86400000).toISOString().slice(0, 10);
  const desde = de && de > inicio ? de : inicio;

  const seller = p.get('seller') || '';
  const uf = p.get('uf') || '';
  const tabela = await tabelaPedidos(env);
  const chave = JSON.stringify([tabela, desde, fim, seller, uf]);
  const guardado = cacheLeadTime.get(chave);
  if (guardado && Date.now() - guardado.em < CACHE_FILTROS_MS) return Response.json(guardado.dados);

  const filtros = ['dt_pedido BETWEEN ? AND ?', 'pedido IS NOT NULL'];
  const valores = [desde, fim]; // pedidos até o "Até" (não até o domingo daquela semana)
  if (seller) { filtros.push('n_fornecedor = ?'); valores.push(seller); }
  if (uf) { filtros.push('uf = ?'); valores.push(uf); }

  const colunas = [...new Set(ETAPAS_LEAD_TIME.flatMap(([, de, ate]) => [de, ate]))];
  const medias = ETAPAS_LEAD_TIME.map(([nome, de, ate]) =>
    `AVG(CASE WHEN julianday(${ate}) - julianday(${de}) >= 0 THEN julianday(${ate}) - julianday(${de}) END) AS ${nome},
     COUNT(CASE WHEN julianday(${ate}) - julianday(${de}) >= 0 THEN 1 END) AS n_${nome}`).join(',\n');
  // 2ª consulta: UFs que têm pedidos nessas semanas (do seller escolhido), para o filtro de UF
  const [semanas, ufs] = await env.DB.batch([
    env.DB.prepare(
      `WITH base AS (
         SELECT ${colunas.map(c => `MAX(${c}) AS ${c}`).join(', ')}
         FROM ${tabela} WHERE ${filtros.join(' AND ')}
         GROUP BY pedido
       )
       SELECT date(dt_pedido, '-' || ((CAST(strftime('%w', dt_pedido) AS INTEGER) + 6) % 7) || ' days') AS semana,
              COUNT(*) AS pedidos, ${medias}
       FROM base GROUP BY semana ORDER BY semana`
    ).bind(...valores),
    env.DB.prepare(
      `SELECT DISTINCT uf FROM ${tabela}
       WHERE dt_pedido BETWEEN ? AND ? ${seller ? 'AND n_fornecedor = ?' : ''} AND uf IS NOT NULL AND TRIM(uf) <> ''
       ORDER BY uf`
    ).bind(desde, fim, ...(seller ? [seller] : [])),
  ]);

  const dados = {
    inicio, fim: ultimo, semanas: semanasMostradas, seller, uf,
    linhas: semanas.results || [],
    ufs: (ufs.results || []).map(r => r.uf),
  };
  if (cacheLeadTime.size > 50) cacheLeadTime.clear();
  cacheLeadTime.set(chave, { em: Date.now(), dados });
  return Response.json(dados);
}

// Relatório para baixar: todas as colunas da base geral (as 3 bases unificadas, com as colunas da planilha).
// A tela pede em partes de 1.000 linhas e monta o arquivo. O cursor é o rowid: cada parte continua de onde a
// anterior parou, então o download inteiro lê a tabela uma vez só (~1 linha lida por linha do relatório).
const LINHAS_POR_PARTE_RELATORIO = 1000;
const SEP_TRANSPORTE = '\x1f'; // base_geral.transportes = "transportadora␟cte,transportadora␟cte,…"

async function relatorio(env, p) {
  if (await tabelaPedidos(env) !== 'base_geral') {
    return erro(503, 'O relatório volta quando a base geral terminar a primeira carga (Job do Databricks, 8h e 12h).');
  }
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
  // Só entram as combinações transportadora × seller de REGRAS_RELATORIO ("Todas" = todas as regras),
  // procurando em base_geral.transportes (tracking + planilha, já juntados por NF + seller pelo Job)
  const transportadora = p.get('transportadora');
  const regras = transportadora ? REGRAS_RELATORIO.filter(r => r.valor === transportadora) : REGRAS_RELATORIO;
  if (!regras.length) return erro(400, 'Transportadora não disponível no relatório');
  filtros.push(`(${regras.map(r =>
    `(e.n_fornecedor IN (${r.sellers.map(() => '?').join(', ')}) AND e.transportes LIKE ?)`).join(' OR ')})`);
  valores.push(...regras.flatMap(r => [...r.sellers, `%${r.contem}%`]));

  const { results } = await env.DB.prepare(
    `SELECT e.rowid AS _id, e.* FROM base_geral e WHERE ${filtros.join(' AND ')} ORDER BY e.rowid LIMIT ?`
  ).bind(...valores, LINHAS_POR_PARTE_RELATORIO).all();

  // Transportadora e CT-e do relatório: só os da regra que vale para o seller da linha
  const itens = (results || []).map(({ row_hash, transportes, ...linha }) => {
    const daRegra = regras.filter(r => r.sellers.includes(linha.n_fornecedor));
    const pares = String(transportes || '').split(',').map(par => par.split(SEP_TRANSPORTE))
      .filter(([transp]) => transp && daRegra.some(r => transp.toUpperCase().includes(r.contem)));
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
// GRU - KM CARGO só Brascol; LLS só Vitrola e Tramontina; LATAM (vem da planilha CONTROLE_AÉREO).
// contem = texto procurado no nome da transportadora (tracking ou planilha); sellers = valores de n_fornecedor.
const REGRAS_RELATORIO = [
  { valor: 'GRU', rotulo: 'GRU - KM CARGO (Brascol)', contem: 'GRU - KM CARGO', sellers: ['Brascol'] },
  { valor: 'LLS', rotulo: 'LLS TRANSPORTE (Vitrola e Tramontina)', contem: 'LLS TRANSPORTE', sellers: ['Vitrola', 'Tramontina'] },
  { valor: 'LATAM', rotulo: 'LATAM', contem: 'LATAM', sellers: ['Brascol', 'Vitrola', 'Tramontina'] },
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
