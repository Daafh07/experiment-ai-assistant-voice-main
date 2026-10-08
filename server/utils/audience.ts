import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { H3Event } from 'h3'

// Questions from the audience: people scan a QR code, type a question on
// their phone, and it waits here until the presenter lets Ayla answer it.
// Everything lives in memory, so a restart clears it and makes a new token.
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
  const direct = event.node.req.socket?.remoteAddress
  if (direct) return direct
  const forwarded = getRequestHeader(event, 'x-forwarded-for') ?? ''
  return forwarded.split(',').pop()?.trim() || 'unknown'
}

// Only the presenter's own laptop may read and handle the queue.
// The dev proxy doesn't protect X-Forwarded-For, so we also require that the
// page was opened via "localhost": a browser on a phone can't fake the Host
// header. (A tool like curl on the same Wi-Fi still could; acceptable for a
// demo, since the worst it can do is read or skip questions.)
export function isPresenter(event: H3Event): boolean {
  const host = getRequestHost(event).split(':')[0]
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientIp(event))
  return local && (host === 'localhost' || host === '127.0.0.1')
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
