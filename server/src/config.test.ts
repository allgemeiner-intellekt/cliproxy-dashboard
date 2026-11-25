import { describe, expect, test } from 'bun:test'
import { parseEnv } from './config'

const KEY = { CPA_MANAGEMENT_KEY: 'secret' }

describe('parseEnv', () => {
  test('defaults', () => {
    expect(parseEnv(KEY)).toEqual({
      managementKey: 'secret',
      proxyUrl: 'http://127.0.0.1:8317',
      proxyHost: '127.0.0.1',
      proxyPort: 8317,
      host: '127.0.0.1',
      port: 5174,
      staticDir: 'dist',
      databasePath: 'data/usage.db',
      priceCachePath: 'data/litellm-prices.json',
    })
  })

  test('empty values count as unset', () => {
    const env = parseEnv({ ...KEY, USAGE_SERVER_PORT: '', CPA_TARGET: ' ', USAGE_DB_PATH: '' })
    expect(env.port).toBe(5174)
    expect(env.proxyPort).toBe(8317)
    expect(env.databasePath).toBe('data/usage.db')
  })

  test('requires the management key', () => {
    expect(() => parseEnv({})).toThrow('CPA_MANAGEMENT_KEY is not set')
  })

  test('rejects bad listen ports', () => {
    for (const port of ['abc', '0', '65536', '51.5', '-1', '5174x']) {
      expect(() => parseEnv({ ...KEY, USAGE_SERVER_PORT: port })).toThrow('USAGE_SERVER_PORT must be a port number')
    }
    expect(parseEnv({ ...KEY, USAGE_SERVER_PORT: '8080' }).port).toBe(8080)
  })

  test('proxy port: explicit, including the scheme default, or 8317', () => {
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http://proxy.lan' }).proxyPort).toBe(8317)
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http://proxy.lan/' }).proxyPort).toBe(8317)
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http://proxy.lan:80' }).proxyPort).toBe(80)
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http://proxy.lan:9000/v0' })).toMatchObject({ proxyHost: 'proxy.lan', proxyPort: 9000 })
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http://u:p@proxy.lan:9000' }).proxyPort).toBe(9000)
  })

  test('IPv6 proxy hosts are unbracketed', () => {
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http://[::1]:8317' })).toMatchObject({ proxyHost: '::1', proxyPort: 8317 })
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http://[::1]' })).toMatchObject({ proxyHost: '::1', proxyPort: 8317 })
  })

  test('rejects non-http proxy targets', () => {
    expect(() => parseEnv({ ...KEY, CPA_TARGET: 'https://proxy.example.com' })).toThrow('CPA_TARGET must be an http:// URL')
    expect(() => parseEnv({ ...KEY, CPA_TARGET: '127.0.0.1:8317' })).toThrow('CPA_TARGET')
    expect(() => parseEnv({ ...KEY, CPA_TARGET: 'not a url' })).toThrow('CPA_TARGET is not a valid URL')
  })

  test('reports every problem at once', () => {
    let message = ''
    try {
      parseEnv({ CPA_TARGET: 'https://x', USAGE_SERVER_PORT: 'nope' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('CPA_MANAGEMENT_KEY')
    expect(message).toContain('CPA_TARGET')
    expect(message).toContain('USAGE_SERVER_PORT')
  })
})
