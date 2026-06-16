# esolat-mcp — Cloudflare Worker Edition

[![MCP](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)
[![M365 Copilot](https://img.shields.io/badge/M365-Copilot%20Ready-0078D4)](https://adoption.microsoft.com/en-us/copilot/)

Port of [esolat-mcp](https://github.com/zubir2k/esolat-mcp) to **Cloudflare Workers** as a fully stateless **MCP Streamable HTTP** server.

No Docker. No Python. No server to manage. Runs on Cloudflare's global edge — free tier eligible.

## Features

- ✅ Full MCP Streamable HTTP protocol (JSON-RPC 2.0)
- ✅ Compatible with **M365 Copilot**, Claude.ai, and any MCP HTTP client
- ✅ Token-based auth in URL path (same pattern as Docker edition)
- ✅ Health dashboard endpoint
- ✅ All 3 original tools preserved:
  - `get_monthly_prayer_times` — JAKIM/e-Solat (Malaysia) or Aladhan (global)
  - `find_nearest_mosques` — e-Solat JAKIM (Malaysia) or OpenStreetMap (global)
  - `get_yearly_islamic_events` — JAKIM or Aladhan
- ✅ CORS headers for browser-based clients
- ✅ Batch JSON-RPC support

---

## Quick Deploy

### 1. Prerequisites

```bash
npm install -g wrangler
wrangler login
```

### 2. Clone & Install

```bash
git clone <this-repo>
cd esolat-cfworker
npm install
```

### 3. Set Your Secret Token

```bash
wrangler secret put MCP_WEBHOOK_TOKEN
# Enter a strong random token when prompted
# e.g.: openssl rand -hex 32
```

### 4. Deploy

```bash
npm run deploy
```

Your Worker will be live at:
```
https://esolat-mcp.<your-subdomain>.workers.dev
```

---

## Endpoints

| Path | Description |
|------|-------------|
| `/` | Landing page with endpoint info |
| `/mcp/<TOKEN>/mcp` | **MCP endpoint** — point your client here |
| `/mcp/<TOKEN>/health` | Health dashboard (upstream API status) |

---

## Connecting to M365 Copilot

In **Microsoft 365 Copilot Studio** or **Copilot extensibility settings**:

1. Add a new **MCP connector**
2. Set the URL to:
   ```
   https://esolat-mcp.<your-subdomain>.workers.dev/mcp/<YOUR_TOKEN>/mcp
   ```
3. Transport: **Streamable HTTP**
4. No additional auth headers needed (token is in the path)

---

## Local Development

```bash
npm run dev
# Worker runs at http://localhost:8787
```

Test with curl:
```bash
# Initialize
curl -X POST http://localhost:8787/mcp/<TOKEN>/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# List tools
curl -X POST http://localhost:8787/mcp/<TOKEN>/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Get prayer times
curl -X POST http://localhost:8787/mcp/<TOKEN>/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_monthly_prayer_times","arguments":{"location_name":"Kajang"}}}'
```

---

## Architecture

```
M365 Copilot / Claude.ai
        │
        │  HTTPS POST (JSON-RPC 2.0)
        ▼
Cloudflare Workers Edge
  ┌─────────────────────────────┐
  │  Token auth (path-based)    │
  │  MCP protocol handler       │
  │  Tool dispatcher            │
  └─────────────────────────────┘
        │
        ├──► api.waktusolat.app  (Malaysia prayer times)
        ├──► e-solat.gov.my      (JAKIM mosque + events)
        ├──► api.aladhan.com     (Global fallback)
        └──► nominatim.osm.org   (Geocoding)
```

## Credits

- [e-solat JAKIM](https://www.e-solat.gov.my/) — Official Malaysian prayer times
- [WaktuSolat.app](https://waktusolat.app/) — GPS-based prayer time API
- [Aladhan API](https://aladhan.com/prayer-times-api) — Global fallback
- [OpenStreetMap / Overpass API](https://overpass-api.de/) — Global mosque finder
- Original Python server: [zubir2k/esolat-mcp](https://github.com/zubir2k/esolat-mcp)
