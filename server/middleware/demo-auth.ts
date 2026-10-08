import { createHash, timingSafeEqual } from 'node:crypto'
import {
  createError,
  defineEventHandler,
  getRequestHeader,
  getRequestURL,
  setResponseHeader
} from 'h3'

// Browser-native HTTP authentication protects the pages AND the paid APIs.
// Use HTTPS when hosting; HTTP is only suitable for local development.
export default defineEventHandler((event) => {
  const password = useRuntimeConfig(event).demoPassword
  if (!password) {
    // Keep local development possible without configuration, but never
    // accidentally publish an unprotected production demo.
    if (import.meta.dev) return
    throw createError({
      statusCode: 503,
      statusMessage: 'Stel eerst het demowachtwoord in op de server.'
    })
  }

  // Authenticated pages and responses must not end up in a shared cache.
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  setResponseHeader(event, 'Vary', 'Authorization')
  // Visitors may submit a question, but cannot read the queue or call AI.
  const path = getRequestURL(event).pathname
  if ((event.method === 'GET' && path === '/vraag') ||
      (event.method === 'POST' && path === '/api/audience/ask') ||
      (event.method === 'GET' && path === '/pave-logo.png')) return
  const authorization = getRequestHeader(event, 'authorization') ?? ''
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)
  let valid = false
  if (match && match[1]!.length <= 2048) {
    const credentials = Buffer.from(match[1]!, 'base64').toString('utf8')
    // Hash both sides to compare equal-sized buffers in constant time.
    const supplied = createHash('sha256').update(credentials).digest()
    const expected = createHash('sha256').update(`ayla:${password}`).digest()
    valid = timingSafeEqual(supplied, expected)
  }
  if (valid) {
    event.context.demoAuthenticated = true
    return
  }

  setResponseHeader(event, 'WWW-Authenticate', 'Basic realm="Ayla demo", charset="UTF-8"')
  throw createError({
    statusCode: 401,
    statusMessage: 'Log in om de Ayla-demo te openen.'
  })
})
