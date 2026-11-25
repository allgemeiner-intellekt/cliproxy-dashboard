// Server configuration, read once from the environment and validated at
// startup so a bad value fails loudly instead of misbehaving later.
// Bun loads .env.local from the working directory (the repo root).

import { parseEnv, type Env } from './config'

function loadEnv(): Env {
  try {
    return parseEnv(process.env)
  } catch (err) {
    console.error(`[config] ${(err as Error).message}`)
    process.exit(1)
  }
}

export const env = loadEnv()
