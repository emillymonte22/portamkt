export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Endpoint de Login
    if (url.pathname === '/api/login' && request.method === 'POST') {
      try {
        const { username, senha } = await request.json();
        const user = await env.DB.prepare(
          "SELECT * FROM usuarios WHERE username = ? AND senha = ?"
        ).bind(username, senha).first();

        if (user) {
          return Response.json({ success: true, perfil: user.perfil, username: user.username });
        } else {
          return Response.json({ success: false, error: 'Utilizador ou senha incorretos' }, { status: 401 });
        }
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // Endpoint de Gestão de Operações e Agendamentos
    if (url.pathname === '/api/agendamentos') {
      if (request.method === 'GET') {
        try {
          const { results } = await env.DB.prepare(
            "SELECT * FROM agendamentos ORDER BY id DESC LIMIT 100"
          ).all();
          return Response.json(results);
        } catch (error) {
          return Response.json({ error: error.message }, { status: 500 });
        }
      }

      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const { seller, transportadora, motorista, veiculo_placa, nota_fiscal, tipo_carga, data_agendamento, status_etapa } = body;

          await env.DB.prepare(
            `INSERT INTO agendamentos (seller, transportadora, motorista, veiculo_placa, nota_fiscal, tipo_carga, data_agendamento, status_etapa) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(seller, transportadora, motorista, veiculo_placa, nota_fiscal, tipo_carga, data_agendamento, status_etapa || 'Emissão do Pedido').run();

          return Response.json({ success: true });
        } catch (error) {
          return Response.json({ error: error.message }, { status: 500 });
        }
      }
    }

    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
  }
};
