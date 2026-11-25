// Test preload (bunfig.toml): gives the frontend tests a DOM (happy-dom).
// Server tests run in the same process, so Bun's own fetch, Response, etc. are
// put back after registering; frontend tests stub fetch themselves.
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const keep = ['fetch', 'Request', 'Response', 'Headers', 'FormData', 'AbortController', 'AbortSignal', 'DOMException', 'URL', 'URLSearchParams', 'WebSocket', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'Blob', 'File', 'crypto', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone', 'console']
const saved = Object.fromEntries(keep.map((k) => [k, (globalThis as Record<string, unknown>)[k]]))
GlobalRegistrator.register({ url: 'http://localhost/' })
Object.assign(globalThis, saved)

// Tell React this is a test environment, so act() works without warnings.
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
