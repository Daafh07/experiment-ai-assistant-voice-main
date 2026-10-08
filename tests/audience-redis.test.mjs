import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const exec = promisify(execFile)
const binary = process.env.REDIS_SERVER_BIN

function load(path, context) {
  const exports = {}
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  runInNewContext(outputText, { exports, require, ...context })
  return exports
}

// Exercise the production Lua scripts against a real isolated Redis server
// via an Upstash-compatible HTTP adapter, without using a cloud account.
// Run with REDIS_SERVER_BIN=/path/to/redis-server npm test (redis-cli beside it).
test('shared Redis queue survives instances and handles concurrent requests atomically', {
  skip: !binary && 'Set REDIS_SERVER_BIN to run real Redis integration checks'
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ayla-redis-test-'))
  const socket = join(dir, 'redis.sock')
  const redis = spawn(binary, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const command = async (...args) => JSON.parse((await exec(join(dirname(binary), 'redis-cli'), ['-s', socket, '--json', ...args.map(String)])).stdout)
  const rest = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== 'Bearer test-redis-token') {
        res.writeHead(401); res.end('Unauthorized'); return
      }
      let body = ''
      for await (const chunk of req) body += chunk
      const result = await command(...JSON.parse(body))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ result }))
    } catch {
      res.writeHead(500); res.end(JSON.stringify({ error: 'Redis adapter failed' }))
    }
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redis startup timeout')), 10000)
      redis.once('exit', () => { clearTimeout(timer); reject(new Error('Redis exited early')) })
      redis.stdout.on('data', chunk => {
        if (chunk.toString().includes('ready to accept connections') || chunk.toString().includes('Ready to accept connections')) {
          clearTimeout(timer); resolve()
        }
      })
    })
    await new Promise(resolve => rest.listen(0, '127.0.0.1', resolve))
    const config = {
      demoPassword: 'strong-integration-test-password', audienceHosted: true,
      audienceRedisUrl: `http://127.0.0.1:${rest.address().port}`,
      audienceRedisToken: 'test-redis-token', audienceSession: 'integration'
    }
    const createError = details => Object.assign(new Error(details.statusMessage), details)
    function instance(settings = config) {
      const globals = {
        process: { env: { VERCEL_ENV: 'production' } },
        useRuntimeConfig: () => settings, createError
      }
      const utils = load('../server/utils/audience.ts', globals)
      const store = load('../server/utils/audience-store.ts', {
        ...globals, ...utils, fetch, AbortSignal,
        audienceClient: event => event.client,
        clientIp: event => event.ip
      })
      return { ...utils, ...store }
    }
    const first = instance(), second = instance()
    const phone = client => ({ client, ip: '203.0.113.1' })
    const reset = () => command('FLUSHDB')

    await t.test('cold starts share a stable token, queue and ordered IDs', async () => {
      assert.equal(first.audienceToken({}), second.audienceToken({}))
      assert.notEqual(first.audience.token, second.audience.token)
      await first.submitAudienceQuestion(phone('phone1'), 'Eerste vraag', 'Sanne')
      await second.submitAudienceQuestion(phone('phone2'), 'Tweede vraag', '')
      assert.equal((await second.audienceState({})).count, 2)
      const a = await second.takeAudienceQuestion({}, 1)
      assert.equal(a.text, 'Eerste vraag')
      assert.equal(a.name, 'Sanne')
      assert.equal((await first.audienceState({})).next.id, 2)
      const keys = await command('KEYS', '*:queue')
      const ttl = await command('TTL', keys[0])
      assert.ok(ttl > 14390 && ttl <= 14400)
    })

    await t.test('duplicate take requests do not consume the next question', async () => {
      await reset()
      await first.submitAudienceQuestion(phone('p1'), 'Een', '')
      await first.submitAudienceQuestion(phone('p2'), 'Twee', '')
      const results = await Promise.allSettled([
        first.takeAudienceQuestion({}, 1), second.takeAudienceQuestion({}, 1)
      ])
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409)
      assert.equal((await second.audienceState({})).next.id, 2)
    })

    await t.test('simultaneous submissions obey per-phone limits across instances', async () => {
      await reset()
      const results = await Promise.allSettled([
        first.submitAudienceQuestion(phone('same'), 'Een', ''),
        second.submitAudienceQuestion(phone('same'), 'Twee', '')
      ])
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 429)
      await second.submitAudienceQuestion(phone('different'), 'Zelfde wifi, andere telefoon', '')
      assert.equal((await first.audienceState({})).count, 2)
    })

    await t.test('after queue expiry old question IDs cannot consume new questions', async () => {
      await reset()
      await first.submitAudienceQuestion(phone('old-phone'), 'Oud', '')
      const oldId = (await first.audienceState({})).next.id
      const [queueKey] = await command('KEYS', '*:queue')
      await command('DEL', queueKey) // Redis removes this same key on TTL expiry.
      await second.submitAudienceQuestion(phone('new-phone'), 'Nieuw', '')
      assert.notEqual((await second.audienceState({})).next.id, oldId)
      await assert.rejects(first.takeAudienceQuestion({}, oldId), { statusCode: 409 })
      assert.equal((await second.audienceState({})).next.text, 'Nieuw')
    })

    await t.test('queue capacity is enforced under concurrent submissions', async () => {
      await reset()
      const results = await Promise.allSettled(Array.from({ length: 55 }, (_, i) =>
        (i % 2 ? first : second).submitAudienceQuestion(phone(`p${i}`), `Vraag ${i}`, '')
      ))
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 50)
      assert.equal((await first.audienceState({})).count, 50)
      assert.equal(results.filter(result => result.status === 'rejected' && result.reason.statusCode === 503).length, 5)
    })

    await t.test('new presentation and missing/broken Redis do not expose old state', async () => {
      const newSession = instance({ ...config, audienceSession: 'new-demo' })
      assert.notEqual(first.audienceToken({}), newSession.audienceToken({}))
      assert.equal((await newSession.audienceState({})).count, 0)
      await assert.rejects(instance({ ...config, audienceRedisUrl: '', audienceRedisToken: '' }).audienceState({}), { statusCode: 503 })
      await assert.rejects(instance({ ...config, audienceRedisToken: 'wrong' }).audienceState({}), { statusCode: 503 })
    })

    if (process.env.TEST_VERCEL_ARTIFACT) {
      await t.test('built Vercel form submits without demo login; remote presenter handles the question', async () => {
        await reset()
        process.env.NUXT_DEMO_PASSWORD = config.demoPassword
        process.env.NUXT_AUDIENCE_REDIS_URL = config.audienceRedisUrl
        process.env.NUXT_AUDIENCE_REDIS_TOKEN = config.audienceRedisToken
        process.env.NUXT_AUDIENCE_SESSION = 'built-integration'
        const { default: handler } = await import('../.vercel/output/functions/__fallback.func/index.mjs')
        const built = createServer(handler)
        await new Promise(resolve => built.listen(0, '127.0.0.1', resolve))
        const base = `http://127.0.0.1:${built.address().port}`
        const authorization = 'Basic ' + Buffer.from(`ayla:${config.demoPassword}`).toString('base64')
        const headers = { authorization, 'x-forwarded-proto': 'https' }
        try {
          for (const path of ['/', '/api/audience/state', '/api/audience/next', '/api/chat', '/api/speak']) {
            const response = await fetch(base + path, { method: ['/api/audience/next', '/api/chat', '/api/speak'].includes(path) ? 'POST' : 'GET' })
            assert.equal(response.status, 401, path)
          }
          const form = await fetch(base + '/vraag')
          assert.equal(form.status, 200)
          const cookie = form.headers.get('set-cookie').split(';')[0]
          const token = /k: "([a-f0-9]+)"/.exec(await form.text())[1]
          const send = body => fetch(base + '/api/audience/ask', {
            method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body)
          })
          assert.equal((await send({ k: token, text: 'Wat kan PAVE voor mij doen?', name: 'Sanne' })).status, 200)
          assert.equal((await send({ k: token, text: 'Nog een vraag' })).status, 429)
          assert.equal((await send({ k: 'expired', text: 'Oude link' })).status, 403)
          assert.equal((await send({ k: token, text: 42 })).status, 400)
          const stateResponse = await fetch(base + '/api/audience/state', { headers })
          assert.equal(stateResponse.status, 200)
          const state = await stateResponse.json()
          assert.equal(state.count, 1)
          assert.equal(state.next.name, 'Sanne')
          assert.equal(state.url, base.replace('http:', 'https:') + '/vraag')
          const take = () => fetch(base + '/api/audience/next', {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'take', id: state.next.id })
          })
          const response = await take()
          assert.equal(response.status, 200)
          assert.equal((await response.json()).question.text, 'Wat kan PAVE voor mij doen?')
          assert.equal((await take()).status, 409)
          assert.equal((await (await fetch(base + '/api/audience/state', { headers })).json()).count, 0)
        } finally {
          built.closeAllConnections()
          await new Promise(resolve => built.close(resolve))
        }
      })
    }
  } finally {
    rest.closeAllConnections()
    await new Promise(resolve => rest.close(resolve))
    redis.kill('SIGTERM')
    await new Promise(resolve => redis.exitCode !== null ? resolve() : redis.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
