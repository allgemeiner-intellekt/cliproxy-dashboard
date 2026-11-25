# cliproxy-dashboard

A lightweight usage and cost dashboard for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). It subscribes to CLIProxyAPI's usage stream, stores per-request token and API-equivalent cost history in SQLite, serves a T3 Code–style usage view, and exposes a JSON API for querying usage statistics.

<img width="1440" alt="Usage page: cost by provider over 30 days and a breakdown by model" src="docs/usage.png" />

## What it does

- **Usage & cost tracking**: Total spend and tokens by provider, model, day/hour, machine, and upstream account, priced from LiteLLM's public price table (with cache-read savings).
- **JSON API**: Query computed usage summaries directly via `GET /api/usage?range=24h|7d|30d|90d|all&tz=<IANA timezone>` and collector status via `GET /api/health`.
- **Single Bun process**: One Hono server collects CLIProxyAPI usage records into SQLite and serves both the API and the built React UI. No proxy management or config writes are exposed.

## Requirements

- CLIProxyAPI **v7.1.18 or later** (first release with usage Pub/Sub). Tested against v8.0.36.
- Remote management enabled on the proxy with a `secret-key` (used only to authenticate the usage Pub/Sub subscription).
- Usage statistics enabled on the proxy (see below).
- [Bun](https://bun.sh) 1.4+ and Node 22.12+ (for the build), or Docker.

## Quick start

On the machine running CLIProxyAPI:

1. Enable usage records in the proxy's `config.yaml` and restart or let it hot-reload:

   ```yaml
   observability:
     usage:
       usage-statistics-enabled: true
       redis-usage-queue-retention-seconds: 3600
   ```

   On pre-v8 configs the same keys sit at the top level.

2. Configure, build, and run:

   ```sh
   cp .env.example .env.local      # set CPA_MANAGEMENT_KEY, and CPA_TARGET if the proxy isn't on 127.0.0.1:8317
   npm ci
   npm run build
   bun server/src/index.ts
   ```

3. Open <http://127.0.0.1:5174>.

The server logs `[collector] subscribed to CLIProxyAPI usage` once it is receiving records. `GET /api/health` shows the same.

## API

| Endpoint | Purpose |
| -------- | ------- |
| `GET /api/usage?range=30d&tz=UTC` | Aggregated cost, tokens, time series, and breakdowns by provider, model, machine, and account (`range`: `24h`, `7d`, `30d`, `90d`, `all`) |
| `GET /api/health` | Collector connection status, price table timestamp, and Tailscale sync status |
| `GET /api/devices` | Known client keys/IPs with resolved machine names and totals |
| `PUT /api/devices/name` | Assign a custom machine name to a `key` or `ip` identity |
| `DELETE /api/devices/name` | Clear a custom machine name |
| `POST /api/import` | Import historical Claude Code / Codex usage transcripts prior to live collection |

## Configuration

All configuration is environment variables, read from `.env.local` in the working directory (Bun loads it automatically) or the process environment. See [`.env.example`](.env.example). Values are checked at startup: an invalid one stops the server with a message listing every problem. Empty values count as unset.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `CPA_MANAGEMENT_KEY` | required | Plaintext management key (used only to subscribe to the usage queue) |
| `CPA_TARGET` | `http://127.0.0.1:8317` | CLIProxyAPI base URL. Must be `http://`: the usage queue is read over a plaintext connection to this port. Without a port, `8317` is used |
| `USAGE_SERVER_HOST` | `127.0.0.1` | Server listen address |
| `USAGE_SERVER_PORT` | `5174` | Server listen port |
| `USAGE_ALLOWED_HOSTS` | none | Extra `Host` names the API answers to, comma-separated (`.example.com` allows subdomains). IP addresses, `localhost`, this machine's name and `*.ts.net` are always allowed; add a reverse proxy's domain here |
| `TAILSCALE_BIN` | auto | Path to the `tailscale` CLI, used to name machines by their tailnet name |
| `USAGE_DB_PATH` | `data/usage.db` | SQLite database |
| `PRICE_CACHE_PATH` | `data/litellm-prices.json` | Cached LiteLLM price table. The server prices from it at startup and downloads a fresh copy in the background |
| `DASHBOARD_DIST` | `dist` | Built frontend to serve |

## Deploy

### Bun, as a service

Run `bun server/src/index.ts` from the repo directory under systemd, launchd, or similar. Keep `data/` on persistent storage.

### Docker

The image runs as the `bun` user (uid/gid 1000), so the data directory you mount must be writable by it. This applies to a fresh directory, which Docker would otherwise create owned by root, and to a directory written by an older image, which ran as root:

```sh
mkdir -p data && sudo chown -R 1000:1000 data
```

```sh
docker build -t cliproxy-dashboard .
docker run -d --name cliproxy-dashboard --restart unless-stopped \
  --network host \
  --env-file .env.local \
  -v "$PWD/data:/app/data" \
  cliproxy-dashboard
```

### Tailscale

[`deploy/compose.yaml`](deploy/compose.yaml) runs the dashboard next to a Tailscale sidecar that serves it over HTTPS on your tailnet ([`deploy/serve.json`](deploy/serve.json)). As with plain Docker, the data directory must belong to uid 1000. Run `mkdir -p "$DATA/data" && sudo chown -R 1000:1000 "$DATA/data"` before the first start. When upgrading from an image that ran as root, run the `chown` before starting the new image.

The image has a `HEALTHCHECK`. It fails, and `GET /api/health` returns 503, once the collector has been disconnected from CLIProxyAPI for more than 2 minutes.

## Security

- **The dashboard has no login.** Anyone who can reach it can read usage and device data, rename machines (`PUT`/`DELETE /api/devices/name`), and import historical transcripts (`POST /api/import`). It binds to `127.0.0.1` by default; to reach it from elsewhere, use an SSH tunnel, `tailscale serve` with Tailnet ACLs, or a reverse proxy with its own authentication. Do not expose it directly to an untrusted network.
- **Browser protections.** The API only answers requests whose `Host` is an IP address, `localhost`, this machine's name, a `*.ts.net` name or one listed in `USAGE_ALLOWED_HOSTS`, which blocks DNS-rebinding pages. Writes must be `Content-Type: application/json`, which other websites can't send without a CORS preflight that the server never grants. These keep other websites out; they don't replace a login.
- **Behind a reverse proxy**, the check only sees the `Host` the proxy forwards. Forward the browser's original `Host` (nginx: `proxy_set_header Host $host;`) and list it in `USAGE_ALLOWED_HOSTS`, or make the proxy reject requests for names it doesn't serve (no catch-all default server forwarding here). A proxy that rewrites `Host` to `127.0.0.1` for every name lets a rebinding page through.
- `data/usage.db` and its WAL files are created readable by their owner only (`0600`), and existing ones are tightened at startup.
- `CPA_MANAGEMENT_KEY` stays server-side and is used only to authenticate the usage Pub/Sub subscription; no CLIProxyAPI management endpoints are proxied.

## Limitations

- **Single consumer of usage records.** CLIProxyAPI deletes a usage record once it is read, so this server must be the only consumer reading the usage queue. Records produced while the server is down are kept for at most `redis-usage-queue-retention-seconds` (max 3600).
- Costs are API-equivalent estimates from LiteLLM's public list prices, not actual subscription billing. Models missing from LiteLLM's table show as unpriced unless overridden in the `price_overrides` table.

## Development

```sh
npm ci
npm run server        # Usage API and collector on 127.0.0.1:5174
npm run dev           # Vite on 127.0.0.1:5173, proxying /api to the server
```

| Command | Does |
| ------- | ---- |
| `npm run lint` | oxlint; warnings fail the run |
| `npm run server:check` | Type-check the server |
| `npm run build` | Type-check the frontend and its tests, and build into `dist/` |
| `npm test` | Server tests, then frontend tests (happy-dom) in a separate Bun process |
| `npm run db:generate` | Generate a migration after editing `server/src/db/schema.ts` |

### Importing earlier history

Claude Code and Codex transcripts from before the dashboard started collecting can be imported, so usage charts don't start empty:

```sh
bun server/src/import/local.ts                         # this machine's ~/.claude and ~/.codex
bun server/src/import/file.ts export.json --ip <ip>    # an export made on another machine
```

`export.json` has the shape `{ "files": [{ "tool": "claude-code" | "codex", "lines": ["<raw jsonl line>", ...] }] }`.

Both are safe to re-run; only history from before live collection began is imported.

## License

[MIT](LICENSE)
