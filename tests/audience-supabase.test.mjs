import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { PGlite } from '@electric-sql/pglite'

const require = createRequire(import.meta.url)
function load(path, context) {
  const exports = {}
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  runInNewContext(outputText, { exports, require, ...context })
  return exports
}

test('Supabase queue uses the real PostgreSQL migration and server-only RPCs', async (t) => {
  const db = new PGlite()
  const secret = 'sb_secret_integration_test'
  let failure = null
  const functions = {
    ayla_audience_submit: ['p_session', 'p_client', 'p_ip', 'p_text', 'p_name'],
    ayla_audience_state: ['p_session'],
    ayla_audience_take: ['p_session', 'p_id']
  }
  const rpc = async (name, body) => {
    const parameters = functions[name]
    if (!parameters) throw new Error('Unknown RPC')
    return db.transaction(async tx => {
      await tx.exec('set local role service_role')
      const result = await tx.query(`select public.${name}(${parameters.map((_, i) => `$${i + 1}`).join(',')}) as result`, parameters.map(key => body[key]))
      return result.rows[0].result
    })
  }
  const rest = createServer(async (req, res) => {
    if (failure) {
      res.writeHead(failure.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: failure.code, message: secret }))
      return
    }
    if (req.headers.apikey !== secret || req.headers.authorization) {
      res.writeHead(401); res.end('Invalid server key'); return
    }
    try {
      let body = ''
      for await (const chunk of req) body += chunk
      const name = req.url.split('/').pop()
      const result = await rpc(name, JSON.parse(body))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(result))
    } catch {
      res.writeHead(400); res.end('RPC failed')
    }
  })
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;')
    const migration = readFileSync(new URL('../supabase/migrations/202610080001_audience.sql', import.meta.url), 'utf8')
    await db.exec(migration)
    await db.exec(migration) // Re-running the setup must preserve the schema.
    await new Promise(resolve => rest.listen(0, '127.0.0.1', resolve))
    const config = {
      demoPassword: 'strong-integration-password', audienceHosted: true,
      supabaseUrl: `http://127.0.0.1:${rest.address().port}`, supabaseSecretKey: secret,
      audienceSession: 'supabase-test'
    }
    function instance(settings = config) {
      const globals = { process: { env: { VERCEL_ENV: 'production' } }, useRuntimeConfig: () => settings,
        createError: details => Object.assign(new Error(details.statusMessage), details) }
      const utils = load('../server/utils/audience.ts', globals)
      return { ...utils, ...load('../server/utils/audience-store.ts', {
        ...globals, ...utils, fetch, AbortSignal,
        audienceClient: event => event.client, clientIp: event => event.ip
      }) }
    }
    const first = instance(), second = instance()
    const phone = i => ({ client: i.toString(16).padStart(32, '0'), ip: '203.0.113.1' })
    const reset = () => db.exec('truncate ayla_private.audience_sessions cascade')

    await t.test('separate server instances share questions and stable session IDs', async () => {
      assert.equal(first.audienceToken({}), second.audienceToken({}))
      await first.submitAudienceQuestion(phone(1), 'Eerste vraag', 'Sanne')
      await second.submitAudienceQuestion(phone(2), 'Tweede vraag', '')
      const state = await second.audienceState({})
      assert.equal(state.count, 2)
      assert.equal(state.next.name, 'Sanne')
      assert.equal((await first.takeAudienceQuestion({}, state.next.id)).text, 'Eerste vraag')
      assert.equal((await second.audienceState({})).next.text, 'Tweede vraag')
    })
    await t.test('duplicate handling preserves the following question', async () => {
      await reset()
      await first.submitAudienceQuestion(phone(1), 'Een', '')
      await first.submitAudienceQuestion(phone(2), 'Twee', '')
      const id = (await first.audienceState({})).next.id
      const results = await Promise.allSettled([first.takeAudienceQuestion({}, id), second.takeAudienceQuestion({}, id)])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(results.find(r => r.status === 'rejected').reason.statusCode, 409)
      assert.equal((await second.audienceState({})).next.text, 'Twee')
    })
    await t.test('phone rate limit and queue capacity survive separate requests', async () => {
      await reset()
      const duplicates = await Promise.allSettled([
        first.submitAudienceQuestion(phone(1), 'Een', ''), second.submitAudienceQuestion(phone(1), 'Dubbel', '')
      ])
      assert.equal(duplicates.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(duplicates.find(r => r.status === 'rejected').reason.statusCode, 429)
      const results = await Promise.allSettled(Array.from({ length: 54 }, (_, i) => second.submitAudienceQuestion(phone(i + 2), `Vraag ${i}`, '')))
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 49)
      assert.equal((await first.audienceState({})).count, 50)
    })
    await t.test('expiration, cleanup and session rotation remove or isolate questions', async () => {
      const oldId = (await first.audienceState({})).next.id
      await db.exec("update ayla_private.audience_sessions set expires_at = now() - interval '1 second'")
      assert.equal((await second.audienceState({})).count, 0)
      await first.submitAudienceQuestion(phone(100), 'Nieuw', '')
      assert.notEqual((await second.audienceState({})).next.id, oldId)
      await assert.rejects(second.takeAudienceQuestion({}, oldId), { statusCode: 409 })
      assert.equal((await instance({ ...config, audienceSession: 'next-demo' }).audienceState({})).count, 0)
      await db.exec("update ayla_private.audience_sessions set expires_at = now() - interval '1 second'; select ayla_private.cleanup_audience()")
      assert.equal((await db.query('select count(*)::integer as count from ayla_private.audience_questions')).rows[0].count, 0)
      assert.equal((await db.query('select count(*)::integer as count from ayla_private.audience_clients')).rows[0].count, 0)
    })
    await t.test('anonymous and logged-in Supabase users cannot access tables or RPCs', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`)
        try {
          await assert.rejects(db.query('select public.ayla_audience_state($1)', ['a'.repeat(64)]), { code: '42501' })
          await assert.rejects(db.query('select * from ayla_private.audience_questions'), { code: '42501' })
        } finally { await db.exec('reset role') }
      }
      assert.equal((await db.query("select count(*)::integer as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ayla_private' and c.relkind='r' and c.relrowsecurity")).rows[0].count, 4)
    })
    await t.test('partial config fails closed and Supabase takes precedence over Redis', async () => {
      await assert.rejects(instance({ ...config, supabaseSecretKey: '' }).audienceState({}), { statusCode: 503 })
      await assert.rejects(instance({ ...config, supabaseSecretKey: ' sb_publishable_wrong ' }).audienceState({}), error => {
        assert.equal(error.statusCode, 503)
        assert.match(error.statusMessage, /publieke key.*sb_secret_/)
        assert.equal(error.statusMessage.includes('sb_publishable_wrong'), false)
        return true
      })
      await assert.rejects(instance({ ...config, supabaseSecretKey: 'sb_secret_wrong' }).audienceState({}), { statusCode: 503 })
      const configured = instance({ ...config, audienceRedisUrl: 'https://unused.example', audienceRedisToken: 'unused' })
      assert.equal(configured.audienceBackend({}), 'supabase')
      assert.equal((await configured.audienceState({})).count, 0)
    })
    await t.test('presenter gets actionable status codes without leaking provider bodies or keys', async () => {
      try {
        for (const [status, code, expected] of [
          [401, '', /serverkey/],
          [401, '42501', /geen toegang/],
          [403, '42501', /geen toegang/],
          [404, 'PGRST202', /wachtrij ontbreekt/],
          [404, '', /Data API/],
          [503, 'PGRST002', /HTTP 503, PGRST002/]
        ]) {
          failure = { status, code }
          await assert.rejects(first.audienceState({ context: { demoAuthenticated: true } }), error => {
            assert.match(error.statusMessage, expected)
            assert.equal(error.data.supabaseStatus, status)
            assert.equal(error.data.supabaseCode, code || null)
            assert.equal(error.statusMessage.includes(secret), false)
            return true
          })
          await assert.rejects(first.audienceState({}), error => {
            assert.equal(error.statusMessage, 'Publieksvragen zijn even niet bereikbaar. Controleer de Supabase-koppeling.')
            assert.equal(error.data, undefined)
            return true
          })
        }
      } finally { failure = null }
    })
    if (process.env.TEST_VERCEL_ARTIFACT) {
      await t.test('Vercel artifact routes visitor submission to Supabase and protects presenter', async () => {
        process.env.NUXT_DEMO_PASSWORD = config.demoPassword
        process.env.NUXT_SUPABASE_URL = config.supabaseUrl
        process.env.NUXT_SUPABASE_SECRET_KEY = config.supabaseSecretKey
        const { default: handler } = await import('../.vercel/output/functions/__fallback.func/index.mjs')
        const built = createServer(handler)
        await new Promise(resolve => built.listen(0, '127.0.0.1', resolve))
        const base = `http://127.0.0.1:${built.address().port}`
        const authorization = 'Basic ' + Buffer.from(`ayla:${config.demoPassword}`).toString('base64')
        try {
          assert.equal((await fetch(base + '/api/audience/state')).status, 401)
          const form = await fetch(base + '/vraag')
          assert.equal(form.status, 200)
          const token = /k: "([a-f0-9]+)"/.exec(await form.text())[1]
          const cookie = form.headers.get('set-cookie').split(';')[0]
          const submitted = await fetch(base + '/api/audience/ask', {
            method: 'POST', headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ k: token, text: 'Supabase werkt?', name: 'Sanne' })
          })
          assert.equal(submitted.status, 200)
          const state = await (await fetch(base + '/api/audience/state', { headers: { authorization } })).json()
          assert.equal(state.count, 1)
          const taken = await fetch(base + '/api/audience/next', {
            method: 'POST', headers: { authorization, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'take', id: state.next.id })
          })
          assert.equal(taken.status, 200)
          assert.equal((await taken.json()).question.text, 'Supabase werkt?')
        } finally {
          built.closeAllConnections()
          await new Promise(resolve => built.close(resolve))
        }
      })
    }
  } finally {
    rest.closeAllConnections()
    await new Promise(resolve => rest.close(resolve))
    await db.close()
  }
})
