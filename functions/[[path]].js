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
        // A lista geral de inclusão (card "Coletas LATAM", antes "Inclusão de Coletas") é só do admin (pedido da Emilly em 08/10);
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
    if (path === '/api/indicadores/leadtime' && request.method === 'GET') return await leadTimeSemanal(env, url.searchParams);
    if (path === '/api/controle-pedidos' && request.method === 'GET') {
      if (!['admin', 'comercial'].includes(usuario.perfil)) return erro(403, 'Apenas administrador e comercial');
      return await controlePedidos(env, url.searchParams);
    }
    if (path === '/api/controle-pedidos/cancelar' && request.method === 'POST') {
      if (usuario.perfil !== 'admin') return erro(403, 'Apenas o administrador pode cancelar pedidos');
      return await cancelarPedido(request, env, usuario.username);
    }
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

// Consultas: últimos 100. CD: todas as coletas LATAM liberadas (novas primeiro, recebidas por último).
// Admin: todas as LATAM, bloqueadas primeiro. A tabela é pequena; o LIMIT é só uma proteção (regra 12).
// Aguardando coleta primeiro (as nunca vistas antes), depois coletadas e recebidas no CD
const ORDEM_CD = `CASE WHEN status_cd = 'recebido' THEN 3 WHEN status_cd = 'coletado' THEN 2 WHEN visto_cd_em IS NULL THEN 0 ELSE 1 END`;
const SQL_AGENDAMENTOS = {
  // Card "Coletas LATAM": a tela mostra as 3 últimas e o resto só com filtro de período ou busca (13/10)
  '': 'SELECT * FROM agendamentos ORDER BY id DESC LIMIT 1000',
  cd: `SELECT * FROM agendamentos WHERE UPPER(transportadora) = 'LATAM' AND liberado_latam = 1
       ORDER BY ${ORDEM_CD}, COALESCE(liberado_em, criado_em) DESC LIMIT 1000`,
  admin: `SELECT * FROM agendamentos WHERE UPPER(transportadora) = 'LATAM' ORDER BY liberado_latam, ${ORDEM_CD}, id DESC LIMIT 1000`,
};

async function listarAgendamentos(env, escopo) {
  const sql = SQL_AGENDAMENTOS[escopo];
  if (!sql) return erro(400, 'escopo inválido');
  // Painel Admin: os CT-es novos da LATAM entram como coletas bloqueadas antes de listar
  if (escopo === 'admin') await criarColetasDosCtes(env);
  const { results } = await env.DB.prepare(sql).all();
  const coletas = results || [];
  await anexarAgendaPlanilha(env, coletas);
  return Response.json(coletas);
}

// A planilha CONTROLE_AÉREO tem prioridade (pedido da Emilly, 09/10): cada coleta do portal ganha `planilha` com os
// dados da coleta na planilha — todas as NFs, CT-e, datas, AGENDA CD (= Entrega CD) e status —, achada pelo Nº da
// coleta, pelo CT-e ou por qualquer uma das NFs do mesmo seller (o mesmo número de NF existe em sellers diferentes:
// a 409436 é da Brascol e da Vitrola). O "Recebido no CD" do CD vira conferência contra a AGENDA CD.
// Acima da planilha, o CT-e da LATAM (`cte_latam`, do btracker): as NFs dele valem sobre as da planilha e a data de
// emissão é a data da coleta e do CT-e (decisões da Emilly, 09/10).
async function anexarAgendaPlanilha(env, coletas) {
  if (!coletas.length) return;
  const [{ porNumero, porNfSeller, porCte }, ctes] = await Promise.all([mapaColetasPlanilha(env), mapaCtesLatam(env)]);
  for (const c of coletas) {
    const cte = semZeros(c.cte);
    const notas = String(c.nota_fiscal || '').split('/').map(n => n.trim()).filter(Boolean);
    c.planilha = (c.ncoleta && porNumero.get(String(c.ncoleta))) || (cte && porCte.get(cte))
      || notas.map(n => porNfSeller.get(`${c.seller}|${n}`)).find(Boolean) || null;
    c.planilha_agenda_cd = c.planilha?.agenda_cd || null;
    c.cte_latam = (cte && ctes.get(cte)) || null;
  }
}

const semZeros = v => String(v ?? '').trim().replace(/^0+/, '');

// Coletas da planilha indexadas por Nº da coleta (1ª linha, como o notebook), por CT-e, por NF (a coleta mais recente
// com ela, para a inclusão, que ainda não sabe o seller) e por seller + NF. ~460 linhas lidas; cache de 5 min
// (a planilha só muda no Job das 12h30).
let cacheMapaPlanilha = null;

async function mapaColetasPlanilha(env) {
  if (!cacheMapaPlanilha || Date.now() - cacheMapaPlanilha.em > 5 * 60 * 1000) {
    const { results } = await env.DB.prepare(
      `SELECT linha, ncoleta, fornecedor, transportadora, notas, cte, data_coleta, data_cte, agenda_cd,
              previsao_entrega, status FROM coletas_planilha ORDER BY linha`
    ).all();
    const porNumero = new Map();
    const porNf = new Map();
    const porNfSeller = new Map();
    const porCte = new Map();
    for (const r of results || []) {
      const coleta = { ...r, seller: nomeSeller(r.fornecedor), notas_lista: notasDaPlanilha(r.notas) };
      if (!porNumero.has(String(r.ncoleta))) porNumero.set(String(r.ncoleta), coleta);
      if (semZeros(r.cte)) porCte.set(semZeros(r.cte), coleta);
      for (const nf of coleta.notas_lista) {
        porNf.set(nf, coleta);
        porNfSeller.set(`${coleta.seller}|${nf}`, coleta);
      }
    }
    cacheMapaPlanilha = { em: Date.now(), porNumero, porNf, porNfSeller, porCte };
  }
  return cacheMapaPlanilha;
}

// ---------- CT-es da LATAM (tabela ctes_latam, do btracker, gravada pelo Job) ----------
// Tabela pequena (um CT-e por linha, ~25 em out/2026); cache de 5 min.
let cacheCtesLatam = null;

async function mapaCtesLatam(env) {
  if (!cacheCtesLatam || Date.now() - cacheCtesLatam.em > 5 * 60 * 1000) {
    const { results } = await env.DB.prepare(
      'SELECT cte, emissao, emissao_hora, seller, notas, qtd_notas FROM ctes_latam LIMIT 2000'
    ).all();
    const mapa = new Map();
    for (const r of results || []) mapa.set(semZeros(r.cte), { ...r, notas_lista: notasDaPlanilha(r.notas) });
    cacheCtesLatam = { em: Date.now(), mapa };
  }
  return cacheCtesLatam.mapa;
}

// Cada CT-e novo da LATAM vira coleta bloqueada no portal; o admin libera para o CD (decisão da Emilly, 09/10).
// Só os emitidos nos últimos DIAS_CTE_NOVO dias (os antigos já passaram pela planilha) e que ainda não estão no portal
// (pelo CT-e ou pelo Nº da coleta da planilha). Fica de fora o CT-e refeito: outro mais novo com as mesmas NFs
// (ex.: 722341 e 722358, 21/09). Feito ao abrir o Painel Admin, no máximo a cada 5 min.
const DIAS_CTE_NOVO = 7;
let ultimaCriacaoCtes = 0;

async function criarColetasDosCtes(env) {
  if (Date.now() - ultimaCriacaoCtes < 5 * 60 * 1000) return;
  ultimaCriacaoCtes = Date.now();
  const desde = new Date(Date.now() - DIAS_CTE_NOVO * 86400000).toISOString().slice(0, 10);
  const [ctes, { porCte }, { results: existentes }] = await Promise.all([
    mapaCtesLatam(env),
    mapaColetasPlanilha(env),
    env.DB.prepare('SELECT cte, ncoleta FROM agendamentos LIMIT 5000').all(),
  ]);
  const ctesNoPortal = new Set((existentes || []).map(a => semZeros(a.cte)).filter(Boolean));
  const coletasNoPortal = new Set((existentes || []).map(a => String(a.ncoleta || '')).filter(Boolean));
  const todos = [...ctes.values()];
  const novos = todos.filter(c => c.emissao >= desde && !ctesNoPortal.has(semZeros(c.cte))
    && !todos.some(o => o.notas === c.notas && o.emissao_hora > c.emissao_hora));

  const inserir = [];
  for (const c of novos) {
    const planilha = porCte.get(semZeros(c.cte));
    if (planilha?.status === 'ENTREGUE' || (planilha?.ncoleta && coletasNoPortal.has(String(planilha.ncoleta)))) continue;
    inserir.push(env.DB.prepare(
      `INSERT INTO agendamentos (seller, transportadora, nota_fiscal, cte, data_coleta, data_cte, status_etapa,
                                 liberado_latam, origem, ncoleta)
       VALUES (?, 'LATAM', ?, ?, ?, ?, 'CT-e emitido', 0, 'cte', ?)`
    ).bind(c.seller || '—', normalizarNotas(c.notas_lista.join('/')), semZeros(c.cte), c.emissao, c.emissao,
      planilha?.ncoleta ? String(planilha.ncoleta) : null));
  }
  if (inserir.length) await env.DB.batch(inserir);
}

// "617980 / 617986" → ['617980', '617986'] (sem zeros à esquerda, como o portal guarda)
const notasDaPlanilha = texto => normalizarNotas(String(texto || '').replace(/[^\d]+/g, '/')).split('/').filter(Boolean);

// FORNECEDOR da planilha → nome do seller no portal (BRASCOL/ONESHOP → Brascol…)
function nomeSeller(fornecedor) {
  const nome = String(fornecedor || '').toUpperCase();
  return Object.keys(SELLER_NA_PLANILHA).find(s => SELLER_NA_PLANILHA[s].some(n => nome.includes(n))) || fornecedor || null;
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
    // Pedido da Emilly (13/10): o aviso vale enquanto a coleta está disponível (aguardando coleta); some quando o
    // CD confirma a coleta ou o recebimento, e não mais quando o CD só abre a aba
    `SELECT COUNT(*) AS novas FROM agendamentos WHERE ${SQL_LATAM_LIBERADAS} AND COALESCE(status_cd, 'pendente') = 'pendente'`
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

  // 1º: a coleta da planilha que tem alguma dessas NFs (prioridade da planilha; traz TODAS as NFs da coleta)
  const { porNf } = await mapaColetasPlanilha(env);
  const coleta = notas.map(n => porNf.get(n)).find(Boolean);
  if (coleta) {
    return Response.json({
      total: notas.length,
      encontradas: notas.filter(n => coleta.notas_lista.includes(n)).length,
      seller: coleta.seller,
      transportadora: coleta.transportadora,
      cte: coleta.cte,
      data_coleta: coleta.data_coleta,
      data_cte: coleta.data_cte,
      entrega_cd: coleta.agenda_cd,
      ncoleta: coleta.ncoleta,
      status_planilha: coleta.status,
      notas_coleta: coleta.notas_lista.join(' / '),
    });
  }

  // 2º: sem coleta na planilha, procura na base geral (manifest + tracking)
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

// Sinalizar direto da base: coletas LATAM da planilha ainda a caminho que ainda não estão no portal.
// Direto da tabela de coletas da planilha (~460 linhas): vem a coleta inteira, com TODAS as NFs (09/10; antes vinha
// da base geral, que só tem as NFs já ligadas a pedidos). Cache de 5 min, zerado ao liberar.
// Mesma lista do notebook "aereo markt" da Emilly (Cargas em Trânsito)
const STATUS_A_CAMINHO = ['TRANSITO', 'PROGRAMADO', 'EM ROTA CD', 'AGENDADO', 'SEFAZ'];
let cachePlanilhaLatam = null;

async function buscarColetasPlanilha(env, ncoleta = null) {
  const { results } = await env.DB.prepare(
    `SELECT linha, ncoleta, fornecedor, notas, cte, data_coleta, data_cte, agenda_cd, previsao_entrega, status
     FROM coletas_planilha
     WHERE UPPER(transportadora) LIKE '%LATAM%' AND ncoleta IS NOT NULL
       AND status IN (${STATUS_A_CAMINHO.map(() => '?').join(', ')})
       ${ncoleta ? 'AND ncoleta = ?' : ''}
       AND ncoleta NOT IN (SELECT ncoleta FROM agendamentos WHERE ncoleta IS NOT NULL)
       AND ltrim(COALESCE(cte, ''), '0') NOT IN (SELECT ltrim(cte, '0') FROM agendamentos WHERE cte IS NOT NULL AND cte <> '')
     ORDER BY linha`
  ).bind(...STATUS_A_CAMINHO, ...(ncoleta ? [ncoleta] : [])).all();
  const vistas = new Set();
  return (results || [])
    .filter(c => !vistas.has(c.ncoleta) && vistas.add(c.ncoleta))
    .map(c => ({
      ncoleta: c.ncoleta, seller: nomeSeller(c.fornecedor), notas: notasDaPlanilha(c.notas).join('/'),
      cte: c.cte, data_coleta: c.data_coleta, data_cte: c.data_cte, entrega_cd: c.agenda_cd,
      previsao_entrega: c.previsao_entrega, status_planilha: c.status,
    }))
    .sort((a, b) => String(b.data_coleta || '').localeCompare(String(a.data_coleta || '')));
}

async function coletasDaPlanilha(env) {
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
  // Coleta LATAM pode estar na planilha ainda sem NFs: entra assim mesmo; as NFs aparecem pela planilha (prioridade)
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

  // Transportadora (pedido da Emilly, 09/10, no lugar do filtro de status): "sem" = pedidos ainda sem transportadora
  const transportadora = p.get('transportadora');
  if (transportadora === 'sem') {
    filtros.push('transportadora IS NULL');
  } else if (transportadora) {
    filtros.push('transportadora = ?');
    valores.push(transportadora);
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
    // entregas_mkt (antes da 1ª carga da base geral) não tem a coluna transportadora
    const [sellers, transportadoras] = await env.DB.batch([
      env.DB.prepare(`SELECT DISTINCT n_fornecedor AS v FROM ${tabela} WHERE n_fornecedor IS NOT NULL ORDER BY 1`),
      env.DB.prepare(tabela === 'base_geral'
        ? `SELECT DISTINCT transportadora AS v FROM base_geral WHERE transportadora IS NOT NULL ORDER BY 1`
        : `SELECT NULL AS v WHERE 0`),
    ]);
    cacheFiltros = {
      em: Date.now(),
      dados: { sellers: sellers.results.map(r => r.v), transportadoras: transportadoras.results.map(r => r.v) },
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

// Controle de Pedidos (pedido da Emilly, 13/10; só admin e comercial): um pedido de compra por linha com as 8 datas
// (pedido, NF do seller, coleta, CT-e, embarque, Entrega CD, faturamento, entrega ao cliente) do mês escolhido.
// A tela calcula os dias de cada etapa, as médias e quem está aguardando NF ou é considerado cancelado.
// "aguardando": pedidos de 2 a 7 dias atrás (fora do mês escolhido também), para o aviso de NF do seller atrasada.
// Lê só as linhas do mês pelo índice de data (regra 12); cache de 30 min por mês + seller.
const COLUNAS_CONTROLE = `pedido_compra, MAX(n_fornecedor) AS seller, MAX(dt_pedido) AS dt_pedido,
  MAX(NULLIF(nota_fiscal_explode, '')) AS nf_seller, MAX(transportadora) AS transportadora,
  MAX(emissao) AS data_nf, MAX(data_coleta) AS data_coleta, MAX(emissao_cte) AS data_cte,
  MAX(data_embarque) AS data_embarque, MAX(data_entrega) AS entrega_cd, MAX(dt_faturamento) AS faturamento,
  MAX(dt_entrega) AS entrega_cliente`;
const cacheControle = new Map();

async function controlePedidos(env, p) {
  if (await tabelaPedidos(env) !== 'base_geral') return erro(503, 'O controle volta quando a base geral terminar a primeira carga.');
  const hoje = new Date(Date.now() - 4 * 3600000).toISOString().slice(0, 10); // dia de hoje em Manaus
  const mes = p.get('mes') || hoje.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return erro(400, 'Mês inválido');
  const seller = p.get('seller') || '';
  // so=aviso: só os recentes (contador do menu ao entrar no portal, sem ler o mês inteiro)
  const soAviso = p.get('so') === 'aviso';
  // so=atrasados: e-mail de cobrança (13/10) — pedidos do seller SEM NF dos últimos 7 dias (pedido da Emilly; depois
  // disso, sem nenhum dado, o pedido conta como cancelado), menos os de hoje e ontem; a tela escolhe o corte em dias
  // corridos ou úteis. Só ao clicar no botão.
  if (p.get('so') === 'atrasados') {
    if (!seller) return erro(400, 'Escolha o seller');
    const diasAtras = n => new Date(Date.parse(`${hoje}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      `SELECT ${COLUNAS_CONTROLE} FROM base_geral
       WHERE dt_pedido BETWEEN ? AND ? AND pedido_compra IS NOT NULL AND n_fornecedor = ?
       GROUP BY pedido_compra
       HAVING MAX(NULLIF(nota_fiscal_explode, '')) IS NULL AND MAX(emissao) IS NULL
       ORDER BY dt_pedido, pedido_compra LIMIT 1000`
    ).bind(diasAtras(7), diasAtras(2), seller).all();
    const cancelados = await lerCancelados(env);
    return Response.json({ seller, hoje, pedidos: (results || []).filter(x => !cancelados.has(String(x.pedido_compra))) });
  }

  const chave = JSON.stringify([hoje, mes, seller, soAviso]);
  const guardado = cacheControle.get(chave);
  if (guardado && Date.now() - guardado.em < CACHE_FILTROS_MS) return Response.json(comCancelados(guardado.dados, await lerCancelados(env)));

  const diasAtras = n => new Date(Date.parse(`${hoje}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const consulta = (de, ate) => env.DB.prepare(
    `SELECT ${COLUNAS_CONTROLE} FROM base_geral
     WHERE dt_pedido BETWEEN ? AND ? AND pedido_compra IS NOT NULL ${seller ? 'AND n_fornecedor = ?' : ''}
     GROUP BY pedido_compra ORDER BY dt_pedido DESC, pedido_compra DESC LIMIT 5000`
  ).bind(de, ate, ...(seller ? [seller] : []));
  // NF emitida e não coletada (13/10): pedidos dos últimos 62 dias com NF do seller há mais de 1 dia (a base só tem a
  // data, então "24h depois" = NF de anteontem ou antes) e sem coleta nem nenhuma etapa seguinte
  const semColeta = env.DB.prepare(
    `SELECT ${COLUNAS_CONTROLE} FROM base_geral
     WHERE dt_pedido BETWEEN ? AND ? AND pedido_compra IS NOT NULL ${seller ? 'AND n_fornecedor = ?' : ''}
     GROUP BY pedido_compra
     HAVING MAX(emissao) <= ? AND MAX(data_coleta) IS NULL AND MAX(emissao_cte) IS NULL AND MAX(data_embarque) IS NULL
        AND MAX(data_entrega) IS NULL AND MAX(dt_faturamento) IS NULL AND MAX(dt_entrega) IS NULL
     ORDER BY MAX(emissao), pedido_compra LIMIT 1000`
  ).bind(diasAtras(62), hoje, ...(seller ? [seller] : []), diasAtras(2));
  const consultas = [consulta(diasAtras(7), diasAtras(2)), semColeta];
  if (!soAviso) consultas.push(consulta(`${mes}-01`, `${mes}-31`));
  const [recentes, naoColetados, doMes] = await env.DB.batch(consultas);

  const dados = {
    mes, seller, hoje, pedidos: doMes?.results || [], recentes: recentes.results || [],
    sem_coleta: naoColetados.results || [],
  };
  if (cacheControle.size > 50) cacheControle.clear();
  cacheControle.set(chave, { em: Date.now(), dados });
  return Response.json(comCancelados(dados, await lerCancelados(env)));
}

// Pedidos cancelados pelo admin (14/10, migração 011). Lidos a cada consulta, fora do cache de 30 min, para o
// cancelamento valer na hora. Tabela pequena (só os cancelados).
async function lerCancelados(env) {
  const { results } = await env.DB.prepare('SELECT pedido_compra, cancelado_por, cancelado_em FROM pedidos_cancelados').all();
  return new Map((results || []).map(r => [String(r.pedido_compra), r]));
}

// Marca os cancelados na lista do mês (cancelado_por/cancelado_em) e tira eles dos avisos (aguardando NF e NF sem coleta)
function comCancelados(dados, cancelados) {
  if (!cancelados.size) return dados;
  const fora = lista => lista.filter(x => !cancelados.has(String(x.pedido_compra)));
  return {
    ...dados,
    pedidos: dados.pedidos.map(x => {
      const c = cancelados.get(String(x.pedido_compra));
      return c ? { ...x, cancelado_por: c.cancelado_por, cancelado_em: c.cancelado_em } : x;
    }),
    recentes: fora(dados.recentes),
    sem_coleta: fora(dados.sem_coleta),
  };
}

// POST /api/controle-pedidos/cancelar {pedido_compra, cancelado: true/false} — só admin. true marca, false desfaz.
async function cancelarPedido(request, env, username) {
  const { pedido_compra, cancelado } = await request.json().catch(() => ({}));
  const numeroPedido = String(pedido_compra ?? '');
  if (!/^\d{1,15}$/.test(numeroPedido)) return erro(400, 'Pedido inválido');
  if (cancelado) {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO pedidos_cancelados (pedido_compra, cancelado_por, cancelado_em) VALUES (?, ?, ?)'
    ).bind(Number(numeroPedido), username, new Date().toISOString()).run();
  } else {
    await env.DB.prepare('DELETE FROM pedidos_cancelados WHERE pedido_compra = ?').bind(Number(numeroPedido)).run();
  }
  return Response.json({ success: true });
}

// Relatório para baixar: todas as colunas da base geral (as 3 bases unificadas, com as colunas da planilha).
// A tela pede em partes de 1.000 linhas e monta o arquivo. O cursor é o rowid: cada parte continua de onde a
// anterior parou, então o download inteiro lê a tabela uma vez só (~1 linha lida por linha do relatório).
const LINHAS_POR_PARTE_RELATORIO = 1000;
const SEP_TRANSPORTE = '\x1f'; // base_geral.transportes = "transportadora␟cte,transportadora␟cte,…"

async function relatorio(env, p) {
  if (await tabelaPedidos(env) !== 'base_geral') {
    return erro(503, 'O relatório volta quando a base geral terminar a primeira carga (Job do Databricks, 12h30).');
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
