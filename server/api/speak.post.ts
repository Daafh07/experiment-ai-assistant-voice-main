import { Buffer } from 'node:buffer'
import { READ_ALOUD_PROMPT, VOICE_MODEL, VOICE } from '../assistant.config'

// Reads Ayla's answer out loud with the voice model and streams the audio
// to the browser as it is generated, so she starts talking right away
// instead of after the whole answer is done.
// The stream is raw pcm16: 24 kHz, mono, 16-bit signed little-endian.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ text: string }>(event)
  if (!body || typeof body.text !== 'string' || !body.text.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Geef tekst op om voor te lezen.' })
  }
  // The voice reads "PAVE" as French "pavé" now and then, whatever the
  // instructions say. Spelled "Peiv", a Dutch voice says it like the English
  // word "pave". Only the audio changes; the text on screen keeps "PAVE".
  const text = body.text.replace(/\bpav[eé](?![a-zà-ÿ])/gi, 'Peiv')
  const apiKey = useRuntimeConfig().openrouterApiKey
  if (!apiKey) {
    throw createError({ statusCode: 500, statusMessage: 'Missing OPENROUTER_API_KEY.' })
  }

  const started = Date.now()
  // OpenRouter's audio-output models only return audio when streamed, and
  // only as raw pcm16 while streaming.
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VOICE_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: READ_ALOUD_PROMPT },
        { role: 'user', content: `[BEGIN TEKST]\n${text}\n[EINDE TEKST]` }
      ],
      stream: true,
      modalities: ['text', 'audio'],
      audio: { voice: VOICE, format: 'pcm16' }
    })
  })

  if (!res.ok || !res.body) {
    throw createError({ statusCode: 502, statusMessage: await res.text() })
  }

  const upstream = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = '' // partial SSE line carried over between reads
  let firstChunk = true

  // The voice model sometimes keeps talking after the text (for example it
  // answers a question at the end). Stop as soon as what it says gets
  // clearly longer than the text, with a time limit as a safety net.
  let spoken = '' // transcript of what the voice model has said so far
  let bytes = 0
  let silentBytes = 0 // length of the current stretch of silence
  const SILENCE = 48000 * 0.6 // 0.6 s
  let overrunAt: number | null = null // audio position when extra words were detected
  let quietBytes = 0
  const PAUSE = 48000 * 0.12 // a short pause between sentences
  // Tight for short lines ("Hallo allemaal!"), a little room for long ones.
  const maxTranscript = text.length + Math.min(15, text.length * 0.15) + 2
  const maxBytes = (text.length / 9 + 2) * 48000 // slow speech ~9 chars/s, plus 2 s; pcm16 at 24 kHz = 48000 bytes/s
  const finish = (controller: ReadableStreamDefaultController<Uint8Array>, why: string) => {
    console.log(`[ayla] voice ${why} after ${Date.now() - started} ms, ${(bytes / 48000).toFixed(1)} s audio`)
    console.log(`[ayla] voice said: ${spoken}`)
    upstream.cancel().catch(() => {})
    controller.close()
  }

  const audio = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await upstream.read()
        if (done) return finish(controller, 'done')
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        let sent = false
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') continue

          const payload = JSON.parse(data)
          if (payload.error) throw new Error(payload.error.message || 'Voice generation failed')
          const audio = payload.choices?.[0]?.delta?.audio
          if (audio?.transcript) spoken += audio.transcript
          if (bytes > maxBytes) return finish(controller, 'cut off (time limit)')
          // The transcript runs about two seconds ahead of the audio, so when it
          // shows extra words the audio is usually still on the last sentence.
          // Don't cut right away (that would be mid-word): remember it and stop
          // at the next short pause, which is where the extra words begin.
          if (overrunAt === null && spoken.length > maxTranscript) overrunAt = bytes
          if (!audio?.data) continue
          if (firstChunk) {
            console.log(`[ayla] voice starts after ${Date.now() - started} ms`)
            firstChunk = false
          }
          const chunk = new Uint8Array(Buffer.from(audio.data, 'base64'))
          bytes += chunk.length

          // After the last word the model pads with silence; stop there.
          silentBytes = isSilent(chunk) ? silentBytes + chunk.length : 0
          const saidItAll = spoken.length >= text.length * 0.85
          if (silentBytes > (saidItAll ? SILENCE : SILENCE * 4)) return finish(controller, 'done')

          if (overrunAt !== null) {
            quietBytes = isSilent(chunk, 300) ? quietBytes + chunk.length : 0
            if (quietBytes >= PAUSE) return finish(controller, 'stopped at pause before extra words')
            if (bytes - overrunAt > 48000 * 3) return finish(controller, 'cut off (extra words)')
          }

          controller.enqueue(chunk)
          sent = true
        }
        // Hand over what we have; a partial line waits in `buffer`.
        if (sent) return
      }
    },
    cancel() {
      upstream.cancel()
    }
  })

  setResponseHeader(event, 'Content-Type', 'application/octet-stream')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return sendStream(event, audio)
})

// True when a pcm16 chunk is (near) silent.
function isSilent(chunk: Uint8Array, threshold = 200): boolean {
  const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.length / 2))
  for (const sample of samples) if (Math.abs(sample) > threshold) return false
  return true
}
