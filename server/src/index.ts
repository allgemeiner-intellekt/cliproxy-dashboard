// Read-only parallel trial. No management, forwarding, upload or LAN routes.
import { CliproxyCollector } from './collector/cliproxy'
import { openDb } from './db/client'
import { env } from './env'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { basicAuth } from 'hono/basic-auth'
import { createApp } from './http/app'
import { Tailnet } from './tailnet'
import { PriceBook } from './usage/pricing'
import { repriceMissing } from './usage/reprice'

const password = process.env.TRIAL_PASSWORD
if (!password) throw new Error('TRIAL_PASSWORD required')
if (env.host !== '127.0.0.1' || env.proxyHost !== '127.0.0.1') throw new Error('loopback required')
const db = openDb(env.databasePath)
const prices = new PriceBook(db, env.priceCachePath)
await prices.start()
repriceMissing(db, prices)
prices.onRefresh = () => repriceMissing(db, prices)
const collector = new CliproxyCollector(db, prices, { host: env.proxyHost, port: env.proxyPort, managementKey: env.managementKey })
collector.start()
const tailnet = new Tailnet(db)
tailnet.start()
const app = new Hono()
app.use('*', basicAuth({ username: 'trial', password, realm: 'CPA Usage trial' }))
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  if (!['GET', 'HEAD'].includes(c.req.method)) return c.json({ error: 'read-only trial' }, 403)
  const path = c.req.path
  if (path.startsWith('/api/') && !['/api/health','/api/usage','/api/activity','/api/account-hours','/api/devices','/api/keys/labels'].includes(path)) return c.notFound()
  if (/^\/(v0|v1|connect|history|sharing)(\/|$)/.test(path)) return c.notFound()
  await next()
})
app.route('/', createApp(db, collector, prices, tailnet))
app.use('*', serveStatic({ root: env.staticDir }))
app.get('*', serveStatic({ path: `${env.staticDir}/index.html` }))
Bun.serve({ hostname: env.host, port: env.port, fetch: app.fetch })
console.log(`[trial] read-only listening on ${env.host}:${env.port}`)
