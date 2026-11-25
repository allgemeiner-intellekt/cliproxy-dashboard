// Imports a usage export made on a machine that can't reach the dashboard:
//   bun server/src/import/file.ts ~/Downloads/cliproxy-usage-export.json --ip 192.168.1.20
// The IP identifies the machine (rename it on the Usage page). Safe to re-run.

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { openDb } from '../db/client'
import { storageEnv } from '../env'
import { PriceBook } from '../usage/pricing'
import { importTranscripts, type TranscriptFile } from './importer'

const { values, positionals } = parseArgs({ options: { ip: { type: 'string' } }, allowPositionals: true })
const [path] = positionals
if (!path || !values.ip) {
  console.error('usage: bun server/src/import/file.ts <export.json> --ip <machine ip>')
  process.exit(1)
}

const { files } = JSON.parse(readFileSync(path, 'utf8')) as { files: TranscriptFile[] }
const env = storageEnv()
const db = openDb(env.databasePath)
const prices = new PriceBook(env.priceCachePath)
// One-shot: wait (bounded) for a fresh table, else price from the cache.
prices.load()
await prices.refresh()

const result = importTranscripts(db, prices, files, values.ip)
console.log(
  `Imported ${result.imported} requests from ${files.length} files as ${values.ip}` +
    ` (${result.alreadyImported} already imported, ${result.afterCutoff} after live collection began, ${result.invalidTimestamp} with invalid timestamps).`,
)
process.exit(0)
