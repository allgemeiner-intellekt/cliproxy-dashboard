// Usage server: collects CLIProxyAPI usage records into SQLite and serves
// them to the dashboard and API clients.

import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { CliproxyCollector } from './collector/cliproxy'
import { openDb } from './db/client'
import { serverEnv } from './env'
import { createApp } from './http/app'
import { Tailnet } from './tailnet'
import { PriceBook } from './usage/pricing'
import { repriceMissing } from './usage/reprice'

const env = serverEnv()
const db = openDb(env.databasePath)

// Prices from the cached table right away; the download runs in the
// background so a slow network can't hold up collection or the API.
// Backfilled costs are permanent, so stored rows are repriced once the first
// download settles: from the fresh table (onRefresh), or the cache if it failed.
const prices = new PriceBook(db, env.priceCachePath)
prices.onRefresh = () => repriceMissing(db, prices)
void prices
  .start()
  .then((refreshed) => {
    if (!refreshed) repriceMissing(db, prices)
  })
  .catch((err: Error) => console.error(`[pricing] repricing stored requests failed: ${err.message}`))

const collector = new CliproxyCollector(db, prices, {
  host: env.proxyHost,
  port: env.proxyPort,
  managementKey: env.managementKey,
})
collector.start()

const tailnet = new Tailnet(db)
tailnet.start()

const app = new Hono()
app.route('/', createApp(db, collector, prices, tailnet, { allowedHosts: env.allowedHosts }))
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))
app.all('/v0/*', (c) => c.json({ error: 'Not found' }, 404))
if (existsSync(env.staticDir)) {
  app.use('*', serveStatic({ root: env.staticDir }))
  app.get('*', serveStatic({ path: `${env.staticDir}/index.html` }))
}

Bun.serve({ hostname: env.host, port: env.port, fetch: app.fetch })
console.log(`[server] listening on http://${env.host}:${env.port}`)
