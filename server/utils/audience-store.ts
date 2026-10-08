import { createHash } from 'node:crypto'
import type { H3Event } from 'h3'
import type { AudienceQuestion } from './audience'

const QUEUE_TTL = 60 * 60 * 4

// Lua keeps limits, IDs and queue changes atomic across Vercel instances.
// Keep the ID counter after the queue expires, so an old presenter screen
// can never accidentally consume a new question with a reused ID.
export const AUDIENCE_SUBMIT_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 'rate' end
if tonumber(redis.call('GET', KEYS[4]) or '0') >= 60 then return 'rate' end
if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[3]) then return 'full' end
local id = redis.call('INCR', KEYS[2])
local question = cjson.encode({id=id, text=ARGV[1], name=ARGV[2]})
redis.call('RPUSH', KEYS[1], question)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('SET', KEYS[3], '1', 'EX', tonumber(ARGV[4]))
if redis.call('INCR', KEYS[4]) == 1 then redis.call('EXPIRE', KEYS[4], 60) end
return 'ok'
`

export const AUDIENCE_TAKE_SCRIPT = `
local first = redis.call('LINDEX', KEYS[1], 0)
if not first then return '' end
if tonumber(cjson.decode(first).id) ~= tonumber(ARGV[1]) then return '' end
return redis.call('LPOP', KEYS[1])
`

export const AUDIENCE_STATE_SCRIPT = `
local first = redis.call('LINDEX', KEYS[1], 0)
return cjson.encode({count=redis.call('LLEN', KEYS[1]), next=first and cjson.decode(first) or cjson.null})
`

async function redisEval(event: H3Event, script: string, keys: string[], args: string[] = []): Promise<string> {
  const config = useRuntimeConfig(event)
  try {
    const response = await fetch(config.audienceRedisUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.audienceRedisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', script, keys.length, ...keys, ...args]),
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) throw new Error('Redis request failed')
    const data = await response.json() as { result?: string; error?: string }
    if (data.error || typeof data.result !== 'string') throw new Error('Invalid Redis response')
    return data.result
  } catch {
    // Never return credentials or provider error bodies to visitors.
    throw createError({ statusCode: 503, statusMessage: 'Publieksvragen zijn even niet bereikbaar. Probeer het opnieuw.' })
  }
}

function storage(event: H3Event) {
  const token = audienceToken(event)
  return { backend: audienceBackend(event), token, prefix: `ayla:audience:{${token}}` }
}

async function supabaseRpc<T>(event: H3Event, name: string, args: Record<string, string | number>): Promise<T> {
  const config = useRuntimeConfig(event)
  const key = config.supabaseSecretKey
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' }
  // Modern secret keys belong in apikey, not in a JWT Authorization header.
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`
  try {
    const response = await fetch(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) throw new Error('Supabase request failed')
    return await response.json() as T
  } catch {
    throw createError({ statusCode: 503, statusMessage: 'Publieksvragen zijn even niet bereikbaar. Controleer de Supabase-koppeling.' })
  }
}

export async function audienceState(event: H3Event): Promise<{ count: number; next: AudienceQuestion | null }> {
  const { backend, token, prefix } = storage(event)
  if (backend === 'supabase') return supabaseRpc(event, 'ayla_audience_state', { p_session: token })
  if (backend === 'memory') return { count: audience.queue.length, next: audience.queue[0] ?? null }
  return JSON.parse(await redisEval(event, AUDIENCE_STATE_SCRIPT, [`${prefix}:queue`]))
}

export async function submitAudienceQuestion(event: H3Event, text: string, name: string): Promise<void> {
  const { backend, token, prefix } = storage(event)
  const client = audienceClient(event)
  let result: string
  if (backend === 'supabase') {
    const ip = createHash('sha256').update(clientIp(event)).digest('hex')
    result = await supabaseRpc(event, 'ayla_audience_submit', {
      p_session: token, p_client: client, p_ip: ip, p_text: text, p_name: name
    })
  } else if (backend === 'redis') {
    const ip = createHash('sha256').update(clientIp(event)).digest('hex')
    result = await redisEval(event, AUDIENCE_SUBMIT_SCRIPT,
      [`${prefix}:queue`, `${prefix}:id`, `${prefix}:client:${client}`, `${prefix}:ip:${ip}`],
      [text, name, String(AUDIENCE_LIMITS.maxQueue), String(AUDIENCE_LIMITS.secondsBetweenQuestions), String(QUEUE_TTL)])
  } else {
    const now = Date.now()
    for (const [key, time] of audience.lastQuestionFrom) {
      if (now - time >= AUDIENCE_LIMITS.secondsBetweenQuestions * 1000) audience.lastQuestionFrom.delete(key)
    }
    if (audience.lastQuestionFrom.has(client)) result = 'rate'
    else if (audience.queue.length >= AUDIENCE_LIMITS.maxQueue) result = 'full'
    else {
      audience.queue.push({ id: audience.nextId++, text, name })
      audience.lastQuestionFrom.set(client, now)
      result = 'ok'
    }
  }
  if (result === 'rate') throw createError({ statusCode: 429, statusMessage: 'Even geduld, je kunt zo weer een vraag sturen.' })
  if (result === 'full') throw createError({ statusCode: 503, statusMessage: 'Er staan al heel veel vragen klaar. Probeer het straks nog eens.' })
  if (result !== 'ok') throw createError({ statusCode: 503, statusMessage: 'Versturen lukte niet. Probeer het opnieuw.' })
}

export async function takeAudienceQuestion(event: H3Event, id: number): Promise<AudienceQuestion> {
  const { backend, token, prefix } = storage(event)
  let question: AudienceQuestion | null = null
  if (backend === 'supabase') {
    question = await supabaseRpc(event, 'ayla_audience_take', { p_session: token, p_id: id })
  } else if (backend === 'redis') {
    const result = await redisEval(event, AUDIENCE_TAKE_SCRIPT, [`${prefix}:queue`], [String(id)])
    if (result) question = JSON.parse(result)
  } else if (audience.queue[0]?.id === id) {
    question = audience.queue.shift()!
  }
  if (!question) throw createError({ statusCode: 409, statusMessage: 'Deze vraag is al behandeld. De wachtrij wordt vernieuwd.' })
  return question
}
