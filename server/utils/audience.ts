import { createHmac, randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { H3Event } from 'h3'

// Questions from the audience: people scan a QR code, type a question on
// their phone, and it waits here until the presenter lets Ayla answer it.
// Local development can use memory; hosted deployments use audience-store's
// shared Supabase/Redis backend and a stable token across instances.
export type AudienceQuestion = { id: number; text: string; name: string }

export const audience = {
  // Session token for submissions and QR links. The short /vraag page
  // supplies the current token, while old QR links expire after a restart.
  token: randomBytes(4).toString('hex'),
  queue: [] as AudienceQuestion[],
  nextId: 1,
  lastQuestionFrom: new Map<string, number>() // ip -> time, for the rate limit
}

export const AUDIENCE_LIMITS = {
  maxLength: 200,
  maxNameLength: 40,
  maxQueue: 50,
  secondsBetweenQuestions: 10
}

// The address a request really comes from. In dev mode Nuxt puts a proxy in
// front of the server, which only passes the address on in X-Forwarded-For.
// A phone can fill in that header itself, so only the last entry (the one the
// proxy adds) can be trusted.
export function clientIp(event: H3Event): string {
  // Vercel replaces this header with the actual caller's address.
  if (process.env.VERCEL) return getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const direct = event.node.req.socket?.remoteAddress
  if (direct) return direct
  const forwarded = getRequestHeader(event, 'x-forwarded-for') ?? ''
  return forwarded.split(',').pop()?.trim() || 'unknown'
}

// An authenticated demo user may read and handle the queue from any device.
// Without a configured login, local development only trusts this laptop.
// The dev proxy doesn't protect X-Forwarded-For, so we also require that the
// page was opened via "localhost": a browser on a phone can't fake the Host
// header. (A tool like curl on the same Wi-Fi still could; acceptable for a
// demo, since the worst it can do is read or skip questions.)
export function isPresenter(event: H3Event): boolean {
  if (event.context.demoAuthenticated === true) return true
  const host = getRequestHost(event).split(':')[0]
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIp(event))
  return local && (host === 'localhost' || host === '127.0.0.1')
}

// Shared deployments need a stable session across cold starts and instances.
// A new AUDIENCE_SESSION or demo password starts a fresh presentation.
export function audienceBackend(event: H3Event): 'supabase' | 'redis' | 'memory' {
  const config = useRuntimeConfig(event)
  if (config.supabaseUrl || config.supabaseSecretKey) {
    if (config.supabaseSecretKey?.trim().startsWith('sb_publishable_')) {
      throw createError({ statusCode: 503, statusMessage: 'SUPABASE_SECRET_KEY bevat een publieke key. Gebruik de geheime serverkey (sb_secret_...) uit hetzelfde Supabase-project en deploy opnieuw.' })
    }
    if (config.supabaseUrl && config.supabaseSecretKey) return 'supabase'
    throw createError({ statusCode: 503, statusMessage: 'Stel de Supabase-URL en geheime serverkey in.' })
  }
  if (config.audienceRedisUrl || config.audienceRedisToken) {
    if (config.audienceRedisUrl && config.audienceRedisToken) return 'redis'
    throw createError({ statusCode: 503, statusMessage: 'Stel de Redis-URL en serverkey in.' })
  }
  if (config.audienceHosted) throw createError({ statusCode: 503, statusMessage: 'Publieksvragen zijn nog niet ingesteld. Koppel eerst Supabase.' })
  return 'memory'
}

export function audienceToken(event: H3Event): string {
  const config = useRuntimeConfig(event)
  if (audienceBackend(event) === 'memory') return audience.token
  if (!config.demoPassword) throw createError({ statusCode: 503, statusMessage: 'Stel eerst het demowachtwoord in.' })
  const environment = process.env.VERCEL_ENV === 'preview'
    ? `preview:${process.env.VERCEL_URL}`
    : process.env.VERCEL_ENV || 'local'
  return createHmac('sha256', config.demoPassword)
    .update(`ayla-audience:${environment}:${config.audienceSession}`)
    .digest('hex')
}

// Rate-limit individual phones, so people sharing the venue's Wi-Fi can
// still submit independently. This cookie grants no presenter access.
export function audienceClient(event: H3Event, create = false): string {
  const existing = getCookie(event, 'ayla-audience-client')
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing
  if (!create) throw createError({ statusCode: 403, statusMessage: 'Open het vragenformulier opnieuw.' })
  const id = randomBytes(16).toString('hex')
  setCookie(event, 'ayla-audience-client', id, {
    httpOnly: true, sameSite: 'strict', secure: Boolean(process.env.VERCEL),
    path: '/', maxAge: 60 * 60 * 4
  })
  return id
}

// The address phones on the same Wi-Fi can reach this laptop on.
export function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}
