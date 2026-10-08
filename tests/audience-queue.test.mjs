import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Run the actual route with an isolated queue so tests never consume live
// audience questions or require an OpenRouter request.
function setup() {
  const audience = {
    queue: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, text: `Vraag ${i + 1}`, name: '' }))
  }
  const exports = {}
  const source = readFileSync(new URL('../server/api/audience/next.post.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  })
  runInNewContext(outputText, {
    exports,
    audience,
    defineEventHandler: (handler) => handler,
    isPresenter: (event) => event.presenter !== false,
    readBody: async (event) => event.body,
    createError: (details) => Object.assign(new Error(details.statusMessage), details),
    console: { log() {} }
  })
  return { audience, handle: exports.default }
}

test('all four questions are handled in order', async () => {
  const { audience, handle } = setup()
  const seen = []
  for (let id = 1; id <= 4; id++) {
    const { question } = await handle({ body: { action: 'take', id } })
    seen.push(question.id)
    assert.equal(audience.queue.length, 4 - id)
  }
  assert.deepEqual(seen, [1, 2, 3, 4])
})

test('simultaneous duplicate requests never consume the next question', async () => {
  const { audience, handle } = setup()
  const results = await Promise.allSettled([
    handle({ body: { action: 'take', id: 1 } }),
    handle({ body: { action: 'take', id: 1 } })
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.statusCode, 409)
  assert.deepEqual(audience.queue.map((question) => question.id), [2, 3, 4])
})

test('invalid, stale and unauthorized requests preserve the queue', async () => {
  const { audience, handle } = setup()
  for (const event of [
    { body: null },
    { body: { action: 'take' } },
    { body: { action: 'unknown', id: 1 } },
    { body: { action: 'take', id: 2 } },
    { presenter: false, body: { action: 'take', id: 1 } }
  ]) {
    await assert.rejects(handle(event))
    assert.equal(audience.queue.length, 4)
  }
})

test('skip removes only the selected question', async () => {
  const { audience, handle } = setup()
  assert.equal((await handle({ body: { action: 'skip', id: 1 } })).question, null)
  assert.deepEqual(audience.queue.map((question) => question.id), [2, 3, 4])
})
