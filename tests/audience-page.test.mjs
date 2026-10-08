import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function render(query) {
  const exports = {}
  const headers = {}
  const source = readFileSync(new URL('../server/routes/vraag.get.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  runInNewContext(outputText, {
    exports,
    audience: { token: 'current-session' },
    AUDIENCE_LIMITS: { maxLength: 200, maxNameLength: 40 },
    defineEventHandler: (handler) => handler,
    getQuery: () => query,
    setResponseHeader: (_, name, value) => { headers[name] = value }
  })
  return { html: exports.default({}), headers }
}

test('typed short URL opens a form that submits with the current session', () => {
  const { html, headers } = render({})
  assert.match(html, /<form id="form">/)
  assert.match(html, /fetch\('\/api\/audience\/ask'/)
  assert.match(html, /k: "current-session"/)
  assert.equal(headers['Cache-Control'], 'no-store')
})

test('current QR link opens the same question form', () => {
  assert.match(render({ k: 'current-session' }).html, /<form id="form">/)
})

test('expired and malformed QR codes do not expose a submission form', () => {
  for (const k of ['old-session', '', ['current-session', 'old-session']]) {
    const { html } = render({ k })
    assert.match(html, /Deze link werkt niet/)
    assert.doesNotMatch(html, /<form|current-session/)
  }
})
