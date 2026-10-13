# Deployment

| Mode | Use for | Entry |
|---|---|---|
| Local, Claude Desktop | Testing, paper trading | `dist/stdio.js` |
| Local, HTTP | Claude Code, MCP Inspector | `dist/http.js` on `127.0.0.1:8787` |
| VPS (Hostinger or any Ubuntu) | 24/7 scanning, recording, live trading, claude.ai web and mobile | `dist/http.js` behind Nginx + HTTPS |

Requires **Node.js 20.6+** (for `--env-file`).

## Local

```bash
git clone https://github.com/YOUR_USERNAME/pumpfun-trader-mcp.git
cd pumpfun-trader-mcp
npm install
npm run build
cp .env.example .env
sed -i '' "s|^MCP_SECRET=.*|MCP_SECRET=$(npm run -s gen-secret)|" .env   # macOS (on Linux: sed -i "...")
sed -i '' "s|^DATA_DIR=.*|DATA_DIR=$PWD/data|" .env
```

### Claude Desktop (stdio)

This command adds the server to `claude_desktop_config.json` and keeps your other settings (macOS path shown):

```bash
node -e '
const fs=require("fs"),path=require("path");
const p=process.env.HOME+"/Library/Application Support/Claude/claude_desktop_config.json";
let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
c.mcpServers=c.mcpServers||{};
c.mcpServers.pumpfun={command:process.execPath,args:["--env-file="+process.cwd()+"/.env",process.cwd()+"/dist/stdio.js"]};
fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(c,null,2));console.log(c)'
```

On Windows the file is `%APPDATA%\Claude\claude_desktop_config.json`. Use the same JSON shape, with escaped backslashes.

Quit Claude Desktop with **Cmd+Q**, reopen it, and check that **pumpfun** appears in the tools menu.
Logs are in `~/Library/Logs/Claude/mcp-server-pumpfun.log`.

> Don't run `dist/http.js` and Claude Desktop at the same time on the same `DATA_DIR`: two processes would write the same state files.

### Local HTTP

```bash
node --env-file=.env dist/http.js
curl http://127.0.0.1:8787/health
claude mcp add --transport http pumpfun http://127.0.0.1:8787/mcp --header "Authorization: Bearer <MCP_SECRET>"
# or inspect:
npx @modelcontextprotocol/inspector     # Streamable HTTP → http://127.0.0.1:8787/mcp/<MCP_SECRET>
```

## VPS (Hostinger)

Use a **VPS (KVM)** plan. Shared or Business web hosting can't keep a websocket and background loops running.

1. **DNS:** in hPanel → Domains → DNS, add an `A` record such as `pump` → VPS IP.
2. **Upload:** `git clone` on the server, or `scp` a zip to `/opt/`.
3. **Set up:**
   ```bash
   cd /opt/pumpfun-trader-mcp
   sudo bash deploy/setup-vps.sh pump.yourdomain.com you@email.com
   ```
   The script installs Node 20, Nginx, Certbot, PM2 and ufw, builds the app, creates `.env` with a
   random `MCP_SECRET`, gets a Let's Encrypt certificate, starts PM2 on boot, and prints your
   connector URL.
4. **Check:** `https://pump.yourdomain.com/health` should return `"streamConnected": true`.

### Connect

| Client | How |
|---|---|
| claude.ai web and mobile | Settings → Connectors → Add custom connector → `https://pump.yourdomain.com/mcp/<MCP_SECRET>` |
| Claude Code | `claude mcp add --transport http pumpfun https://pump.yourdomain.com/mcp --header "Authorization: Bearer <MCP_SECRET>"` |

### Operate

```bash
pm2 logs pumpfun-mcp          # live logs
pm2 restart pumpfun-mcp       # after editing .env or pulling updates
pm2 status

# update
git pull && npm ci && npm run build && pm2 restart pumpfun-mcp

# disk used by recordings
du -sh data/recordings
```

PM2 must run a **single instance**: state and the websocket live in-process.

### Files

| Path | Content |
|---|---|
| `.env` | Settings and secrets (`chmod 600`) |
| `data/state-paper.json`, `data/state-live.json` | Positions, history, limits usage, kill switch |
| `data/signal-journal.json` | Strategy signals and their outcomes |
| `data/recordings/` | Raw stream for backtests |
| `backtest-results/` | Reports |
