import {
  SYSTEM_PROMPT,
  DEMO_PROFILES,
  KLUIS_SECTIONS,
  KLUIS_ACCESS_PROMPT,
  MODEL,
  FALLBACK_MODELS,
  TEMPERATURE
} from '../assistant.config'
import { PIXEL_ICONS } from '../../app/utils/pixelIcons'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

type OpenRouterResponse = {
  model: string
  choices: { message: { content: string | null } }[]
}

// Mistral decides what Ayla says. The app then sends this text to
// /api/speak to have it read out loud.
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    messages: ChatMessage[]
    profile?: string
    granted?: string[] // kluis sections the user allowed Ayla to see
  }>(event)
  if (!body || !Array.isArray(body.messages) || !body.messages.length ||
    body.messages.some((message) => !message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') ||
    (body.granted !== undefined && (!Array.isArray(body.granted) || body.granted.some((key) => typeof key !== 'string'))) ||
    (body.profile !== undefined && typeof body.profile !== 'string')) {
    throw createError({ statusCode: 400, statusMessage: 'Ongeldig gesprek.' })
  }
  const { messages, profile, granted = [] } = body

  const apiKey = useRuntimeConfig().openrouterApiKey
  if (!apiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Missing OPENROUTER_API_KEY. Add it to your .env file (see .env.example).'
    })
  }

  // If a demo kluis is selected, Ayla gets its contents as background
  // knowledge, just like she would know the user's kluis in the real PAVE.
  const demo = profile ? DEMO_PROFILES[profile] : undefined
  // Only the kluis sections the user allowed on the consent card.
  const allowed = granted.filter((key) => key in KLUIS_SECTIONS)
  const access = allowed.length
    ? `Toestemming gegeven voor: ${allowed.join(', ')}.\n\n` +
      allowed.map((key) => `${KLUIS_SECTIONS[key]!.label}:\n${KLUIS_SECTIONS[key]!.content}`).join('\n\n')
    : 'Nog nergens toestemming voor gegeven.'
  const systemPrompt = demo
    ? `${SYSTEM_PROMPT}\n\n## Inhoud van de kluis van deze gebruiker (voorbeelddata)\n${demo.kluis}`
    : `${SYSTEM_PROMPT}\n\n${KLUIS_ACCESS_PROMPT}\n\n${access}`

  console.log(`[ayla] heard: ${messages.at(-1)?.content}`)
  const started = Date.now()
  const response = await completeWithHedging(apiKey, [{ role: 'system', content: systemPrompt }, ...messages])
  console.log(`[ayla] answer from ${response.model} in ${Date.now() - started} ms`)

  // Mistral may end the answer with a tag like [icoon:kluis]; the app turns
  // that into a pixel icon in the orb. The tag itself is never shown or spoken.
  const raw = response.choices?.[0]?.message?.content ?? '(geen antwoord)'
  const tag = raw.match(/\[\s*icoon\s*:\s*([a-z]+)\s*\]/i)?.[1]?.toLowerCase()
  const icon = tag && tag in PIXEL_ICONS ? tag : null
  // [toegang:diplomas,werkervaring] means Ayla asks permission for those
  // kluis sections; the app then shows the consent card.
  const requested = raw.match(/\[\s*toegang\s*:\s*([^\]]*)\]/i)?.[1] ?? ''
  const accessRequest = requested
    .split(',')
    .map((key) => key.trim().toLowerCase().replace(/['’]/g, ''))
    .filter((key) => key in KLUIS_SECTIONS && !allowed.includes(key))
  const reply = stripMarkdown(raw.replace(/\[\s*(icoon|toegang)\s*:[^\]]*\]/gi, '')).trim()

  return {
    reply,
    icon,
    access: accessRequest.length
      ? accessRequest.map((key) => ({ key, label: KLUIS_SECTIONS[key]!.label }))
      : null
  }
})

// Asks the Mistral models in order, but doesn't wait for a slow one: if a
// model hasn't answered within HEDGE_MS, the next one starts alongside it and
// the first good answer wins. A model that fails hands over immediately.
// This keeps Ayla quick when one of the models is busy.
const HEDGE_MS = 3500

function completeWithHedging(apiKey: string, messages: { role: string; content: string }[]) {
  const models = [MODEL, ...FALLBACK_MODELS]
  const controllers: AbortController[] = []
  let next = 0
  let failed = 0
  let done = false

  return new Promise<OpenRouterResponse>((resolve, reject) => {
    const launch = () => {
      if (done || next >= models.length) return
      const model = models[next++]!
      const controller = new AbortController()
      controllers.push(controller)
      const hedge = setTimeout(launch, HEDGE_MS)

      $fetch<OpenRouterResponse>('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: {
          model,
          temperature: TEMPERATURE,
          // Spoken answers should be short; this also keeps the reply fast.
          max_tokens: 400,
          messages
        },
        signal: controller.signal,
        timeout: 25000
      })
        .then((response) => {
          clearTimeout(hedge)
          if (done) return
          if (!response.choices?.[0]?.message?.content) throw new Error(`empty answer from ${model}`)
          done = true
          controllers.forEach((c) => c.abort()) // stop the slower ones
          resolve(response)
        })
        .catch((err) => {
          clearTimeout(hedge)
          if (done) return
          console.warn(`[ayla] ${model} failed: ${err?.message ?? err}`)
          if (++failed === models.length) reject(err)
          else launch()
        })
    }
    launch()
  })
}

// Replies are shown and spoken as plain text, so drop the markdown emphasis
// models sometimes add despite the instructions.
function stripMarkdown(text: string): string {
  return text.replace(/\*\*|__/g, '').replace(/^#{1,6}\s+/gm, '')
}
