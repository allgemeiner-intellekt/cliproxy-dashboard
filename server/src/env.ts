// Configuration from the environment, validated when an entry point asks for
// it so a bad value fails loudly at startup instead of misbehaving later.
// Bun loads .env.local from the working directory (the repo root).

import { parseServerEnv, parseStorageEnv, type ServerEnv, type StorageEnv } from './config'

function orExit<T>(parse: () => T): T {
  try {
    return parse()
  } catch (err) {
    console.error(`[config] ${(err as Error).message}`)
    process.exit(1)
  }
}

// Everything the server needs.
export const serverEnv = (): ServerEnv => orExit(() => parseServerEnv(process.env))

// Just the storage paths, for one-shot tools like the importers.
export const storageEnv = (): StorageEnv => orExit(() => parseStorageEnv(process.env))
