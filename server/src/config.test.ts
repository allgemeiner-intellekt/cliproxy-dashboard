import { describe, expect, test } from 'bun:test'
import { parseServerEnv as parseEnv, parseStorageEnv } from './config'

const KEY = { CPA_MANAGEMENT_KEY: 'secret' }

describe('parseEnv', () => {
  test('defaults', () => {
    expect(parseEnv(KEY)).toEqual({
      managementKey: 'secret',
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

  test('proxy port follows URL parsing, not a looser reading of the text', () => {
    // Extra slashes and embedded tabs are tolerated by URL; the port must match.
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http:///proxy.lan:9000' })).toMatchObject({ proxyHost: 'proxy.lan', proxyPort: 9000 })
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http://proxy.lan:9\t000' }).proxyPort).toBe(9000)
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http:///proxy.lan:80' }).proxyPort).toBe(80)
    expect(parseEnv({ ...KEY, CPA_TARGET: 'http://proxy.lan:080/x' }).proxyPort).toBe(80)
  })

  test('rejects proxy port 0', () => {
    expect(() => parseEnv({ ...KEY, CPA_TARGET: 'http://127.0.0.1:0' })).toThrow('CPA_TARGET port must be from 1 to 65535')
    expect(() => parseEnv({ ...KEY, CPA_TARGET: 'http://127.0.0.1:99999' })).toThrow('CPA_TARGET')
  })

  test('the management key is used exactly as given', () => {
    expect(parseEnv({ CPA_MANAGEMENT_KEY: ' pass word ' }).managementKey).toBe(' pass word ')
    expect(() => parseEnv({ CPA_MANAGEMENT_KEY: '   ' })).toThrow('CPA_MANAGEMENT_KEY is not set')
  })

  test('errors never echo the proxy URL, which may hold credentials', () => {
    for (const target of ['https://admin:hunter2@proxy.example.com', 'http://admin:hunter2@[bad']) {
      let message = ''
      try {
        parseEnv({ ...KEY, CPA_TARGET: target })
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toContain('CPA_TARGET')
      expect(message).not.toContain('hunter2')
    }
  })

  test('storage settings parse without any server settings', () => {
    expect(parseStorageEnv({ USAGE_SERVER_PORT: 'bad', CPA_TARGET: 'https://x' })).toEqual({
      databasePath: 'data/usage.db',
      priceCachePath: 'data/litellm-prices.json',
    })
    expect(parseStorageEnv({ USAGE_DB_PATH: '/srv/u.db' }).databasePath).toBe('/srv/u.db')
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
