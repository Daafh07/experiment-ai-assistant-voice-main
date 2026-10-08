import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const password = 'a-strong-test-password'
const source = readFileSync(new URL('../server/middleware/demo-auth.ts', import.meta.url), 'utf8')

function setup({ configuredPassword = password, dev = false } = {}) {
  const exports = {}
  const { outputText } = ts.transpileModule(source.replaceAll('import.meta.dev', String(dev)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  runInNewContext(outputText, {
    exports, require, Buffer,
    useRuntimeConfig: () => ({ demoPassword: configuredPassword })
  })
  return exports.default
}

// Actual H3 request/response events verify status and authentication headers.
const { createApp, toWebHandler } = await import('h3')
function app(options) {
  let reached = 0
  const server = createApp()
  server.use(setup(options))
  server.use(() => { reached++; return 'private demo' })
  return { handle: toWebHandler(server), reached: () => reached }
}
function request(path = '/', credentials) {
  const headers = credentials === undefined ? {} : { authorization: credentials }
  return new Request(`https://ayla.example${path}`, {
    method: path.startsWith('/api/') ? 'POST' : 'GET', headers
  })
}
const basic = (value) => `Basic ${Buffer.from(value).toString('base64')}`

test('pages, audience form and paid APIs require authentication', async () => {
  const { handle, reached } = app()
  for (const path of ['/', '/vraag', '/api/chat', '/api/speak', '/api/audience/ask']) {
    const response = await handle(request(path))
    assert.equal(response.status, 401)
    assert.match(response.headers.get('www-authenticate'), /^Basic realm="Ayla demo"/)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
  }
  assert.equal(reached(), 0)
})

test('incorrect, malformed and oversized credentials never reach the demo', async () => {
  const { handle, reached } = app()
  for (const credentials of [
    basic('ayla:wrong'), basic(`other:${password}`),
    'Bearer something', 'Basic !!!', basic('x'.repeat(3000))
  ]) {
    assert.equal((await handle(request('/', credentials))).status, 401)
  }
  assert.equal(reached(), 0)
})

test('correct credentials permit pages and APIs without caching', async () => {
  const { handle, reached } = app()
  for (const path of ['/', '/vraag', '/api/chat', '/api/speak']) {
    const response = await handle(request(path, basic(`ayla:${password}`)))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'private demo')
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('vary'), 'Authorization')
  }
  assert.equal(reached(), 4)
})

test('production without a password stays closed; local development remains possible', async () => {
  const production = app({ configuredPassword: '' })
  assert.equal((await production.handle(request())).status, 503)
  assert.equal(production.reached(), 0)
  const development = app({ configuredPassword: '', dev: true })
  assert.equal((await development.handle(request())).status, 200)
})
