# portamkt

Portal Logístico do Bemol Marketplace — https://portamkt.pages.dev

- Tela: `public/index.html` · API: `functions/[[path]].js` · Banco: Cloudflare D1 (`d1/schema.sql`)
- Dados do Databricks sincronizados 1x por dia (8h) pelo Job em `databricks/`
- Push na `main` publica automaticamente no Cloudflare Pages

**Vai alterar o portal com uma IA?** O Claude Code lê o [`CLAUDE.md`](CLAUDE.md) sozinho. Em IAs de chat (Gemini, ChatGPT), cole antes o [`CONTEXTO_IA.md`](CONTEXTO_IA.md) na conversa.
