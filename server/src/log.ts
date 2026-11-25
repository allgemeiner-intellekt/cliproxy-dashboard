// Structured logging: one JSON object per line, so logs can be filtered by
// field (journalctl -o cat | jq 'select(.level == "error")').

type Level = 'info' | 'warn' | 'error'

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

// Error details worth logging, including the stack for unexpected failures.
export function errorFields(err: unknown) {
  return err instanceof Error ? { error: err.message, name: err.name, stack: err.stack } : { error: String(err) }
}
