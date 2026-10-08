<script setup lang="ts">
import type { PixelIconName } from '~/utils/pixelIcons'
import { BLIPS, playBlips } from '~/utils/blips'

type Message = { role: 'user' | 'assistant'; content: string }

// The voice conversation moves through these states. The orb in the
// middle of the screen changes its look for each one.
type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking'

useHead({
  title: 'Ayla · PAVE',
  htmlAttrs: { lang: 'nl' },
  meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' }]
})

const DEFAULT_GREETING = 'Hoi! Ik ben Ayla, je assistent in PAVE. Waar kan ik je mee helpen?'

const messages = ref<Message[]>([{ role: 'assistant', content: DEFAULT_GREETING }])

const state = ref<VoiceState>('idle')
const errorText = ref('') // only shown when something goes wrong

// A session is one ongoing spoken conversation: after Ayla finishes
// talking she starts listening again, until the user taps stop.
let sessionActive = false
let chatAbort: AbortController | null = null

// ---- Speech-to-text (microphone) ----
// Uses the browser's built-in Web Speech API. Chrome/Edge only.
// It listens continuously and only sends the question once you have been
// quiet for a moment, so a short pause halfway doesn't cut the sentence off.
const END_OF_SPEECH_MS = 1200
const voiceSupported = ref(false)
let recognition: any = null
let heard = '' // everything recognised so far in this turn
let sent = false // this turn's question has already been sent
let silenceTimer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  voiceSupported.value = !!SpeechRecognition
  if (!SpeechRecognition) return

  recognition = new SpeechRecognition()
  recognition.lang = 'nl-NL'
  recognition.continuous = true
  recognition.interimResults = true
  recognition.maxAlternatives = 1

  recognition.onresult = (event: any) => {
    let text = ''
    for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript
    heard = text.trim()
    // Wait for a short silence before sending the question.
    clearTimeout(silenceTimer)
    silenceTimer = setTimeout(sendHeard, END_OF_SPEECH_MS)
  }
  recognition.onerror = (event: any) => {
    if (event.error === 'not-allowed') errorText.value = 'Geef toegang tot je microfoon om te praten.'
  }
  recognition.onend = () => {
    if (state.value !== 'listening') return
    // The browser stopped listening by itself: send what we have, or end
    // the session if nothing was said (instead of looping).
    if (heard) sendHeard()
    else stopSession()
  }
})

function sendHeard() {
  clearTimeout(silenceTimer)
  if (sent || !heard || state.value !== 'listening') return
  sent = true
  // "Ja" or "nee" while the consent card is open answers the card.
  if (consentRequest.value) {
    if (SAYS_NO.test(heard)) return answerConsent(false)
    if (SAYS_YES.test(heard)) return answerConsent(true)
  }
  if (granted.value.length && SAYS_REVOKE.test(heard)) return revokeAccess()
  ask(heard)
}

function startListening() {
  if (!recognition) return
  heard = ''
  sent = false
  clearTimeout(silenceTimer)
  state.value = 'listening'
  try {
    recognition.start()
  } catch {
    // Already started; nothing to do.
  }
}

// ---- Text-to-speech (Ayla's voice) ----
// The voice model's audio is streamed in and played as it arrives, so Ayla
// starts talking right away. Everything goes through an analyser that reads
// the loudness, so the orb and page move along with her voice.
const SAMPLE_RATE = 24000 // pcm16 from /api/speak: 24 kHz, mono
let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null // Ayla's voice
let speakAbort: AbortController | null = null
let sources: AudioBufferSourceNode[] = []

function ensureAudioContext() {
  if (audioCtx) return
  audioCtx = new AudioContext()
  analyser = audioCtx.createAnalyser()
  analyser.fftSize = 256
  analyser.connect(audioCtx.destination)
}

// ---- Live audio for the visuals ----
// Loudness and a coarse spectrum of whoever is talking: you (microphone)
// while Ayla listens, Ayla while she speaks. The orb and the page read this
// every frame, so it is a plain object instead of reactive state.
const BANDS = 24
const audio = markRaw({ level: 0, bands: new Float32Array(BANDS) })
let micStream: MediaStream | null = null
let micAnalyser: AnalyserNode | null = null
let meterId = 0

// Only for the visuals; speech recognition uses the microphone on its own.
async function ensureMic() {
  if (micStream || !audioCtx || !navigator.mediaDevices) return
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    micAnalyser = audioCtx.createAnalyser()
    micAnalyser.fftSize = 256
    audioCtx.createMediaStreamSource(micStream).connect(micAnalyser)
  } catch {
    // No microphone access: the visuals fall back to their own animation.
  }
}

function releaseMic() {
  micStream?.getTracks().forEach((track) => track.stop())
  micStream = null
  micAnalyser = null
}

function runMeter() {
  const data = new Uint8Array(128)
  const tick = () => {
    const source = state.value === 'listening' ? micAnalyser : state.value === 'speaking' ? analyser : null
    if (source) {
      source.getByteFrequencyData(data)
      // Speech sits in the lower part of the spectrum: two bins per band.
      let sum = 0
      for (let b = 0; b < BANDS; b++) {
        const v = (data[1 + b * 2]! + data[2 + b * 2]!) / 510
        audio.bands[b] = audio.bands[b]! * 0.6 + v * 0.4
        sum += v
      }
      audio.level = audio.level * 0.7 + Math.min(1, (sum / BANDS) * 1.8) * 0.3
    } else {
      audio.level *= 0.9
      for (let b = 0; b < BANDS; b++) audio.bands[b]! *= 0.9
    }
    updateIcons()
    meterId = requestAnimationFrame(tick)
  }
  tick()
}

onMounted(runMeter)
onBeforeUnmount(() => {
  cancelAnimationFrame(meterId)
  stopSession()
  audioCtx?.close()
})

// Streams the spoken answer and plays each piece as soon as it arrives.
// Resolves when Ayla has finished talking.
async function playStream(text: string, signal: AbortSignal) {
  ensureAudioContext()
  const ctx = audioCtx!
  const res = await fetch('/api/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal
  })
  if (!res.ok || !res.body) throw new Error(`speak failed: ${res.status}`)

  const reader = res.body.getReader()
  let leftover: Uint8Array | null = null // odd byte waiting for its pair
  let playAt = 0
  let last: AudioBufferSourceNode | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    let bytes = value
    if (leftover) {
      bytes = new Uint8Array(leftover.length + value.length)
      bytes.set(leftover)
      bytes.set(value, leftover.length)
    }
    const usable = bytes.length - (bytes.length % 2)
    leftover = usable < bytes.length ? bytes.slice(usable) : null
    if (!usable) continue

    const pcm = new Int16Array(bytes.slice(0, usable).buffer)
    const buffer = ctx.createBuffer(1, pcm.length, SAMPLE_RATE)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i]! / 32768

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(analyser!)
    if (!last) {
      // First audio: a small head start keeps playback smooth.
      playAt = ctx.currentTime + 0.15
      speech.start = playAt
      state.value = 'speaking'
    }
    playAt = Math.max(playAt, ctx.currentTime)
    source.start(playAt)
    playAt += buffer.duration
    speech.length = playAt - speech.start
    sources.push(source)
    last = source
  }
  speech.complete = true

  if (!last) throw new Error('no audio received')
  if (ctx.currentTime >= playAt) return // already finished playing
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', finish)
      resolve()
    }
    last!.onended = finish
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

async function speak(text: string) {
  const controller = new AbortController()
  speakAbort = controller
  try {
    await playStream(text, controller.signal)
    if (controller.signal.aborted) return
    finishedSpeaking()
  } catch (err) {
    if (controller.signal.aborted) return // the user stopped or interrupted
    stopSpeaking()
    console.warn('Voice model failed, using browser voice:', err)
    browserSpeak(text)
  }
}

// Fallback: the browser's built-in voice, if the voice model failed.
function browserSpeak(text: string) {
  state.value = 'speaking'
  if (!('speechSynthesis' in window)) return finishedSpeaking()
  // Dutch voice: spell PAVE so it comes out like the English word "pave".
  const utterance = new SpeechSynthesisUtterance(text.replace(/\bpav[eé](?![a-zà-ÿ])/gi, 'Peiv'))
  utterance.lang = 'nl-NL'
  utterance.onend = finishedSpeaking
  utterance.onerror = () => {
    errorText.value = 'Het voorlezen lukte niet. Probeer het opnieuw.'
    sessionActive = false
    finishedSpeaking()
  }
  window.speechSynthesis.speak(utterance)
}

function finishedSpeaking() {
  sources = []
  if (state.value !== 'speaking') return
  if (sessionActive && recognition) startListening()
  else state.value = 'idle'
}

function stopSpeaking() {
  speakAbort?.abort()
  for (const s of sources) {
    try {
      s.stop()
    } catch {
      // Not started yet or already stopped.
    }
  }
  sources = []
  window.speechSynthesis?.cancel()
}

// ---- Conversation ----
async function ask(text: string) {
  text = text.trim()
  if (!text) return
  chatAbort?.abort()
  const controller = new AbortController()
  chatAbort = controller
  recognition?.abort()
  errorText.value = ''
  messages.value.push({ role: 'user', content: text })
  state.value = 'thinking'

  try {
    const { reply, icon, access } = await $fetch('/api/chat', {
      method: 'POST',
      body: { messages: messages.value, granted: granted.value.map((section) => section.key) },
      signal: controller.signal,
      timeout: 30000 // never stay stuck on "thinking"
    })
    if (controller.signal.aborted || state.value !== 'thinking') return // stopped while waiting
    messages.value.push({ role: 'assistant', content: reply })
    // Ayla asks for access: the card appears once she has finished asking.
    pendingConsent = access ?? null
    prepareIconCues(reply, (icon as PixelIconName | null) ?? null)
    await speak(reply)
  } catch (err: any) {
    if (controller.signal.aborted) return
    errorText.value = 'Er ging iets mis. Probeer het opnieuw.'
    messages.value.push({ role: 'assistant', content: `⚠️ ${err?.data?.statusMessage ?? err.message}` })
    sessionActive = false
    state.value = 'idle'
  }
}

function startSession() {
  ensureAudioContext()
  audioCtx?.resume()
  ensureMic()
  sessionActive = true
  errorText.value = ''
  startListening()
}

function stopSession() {
  sessionActive = false
  chatAbort?.abort()
  clearTimeout(silenceTimer)
  recognition?.abort()
  stopSpeaking()
  releaseMic()
  state.value = 'idle'
}

// ---- Consent (live in the demo) ----
// Ayla only sees the parts of the (example) kluis the user allows. When she
// needs one, the server returns `access` and the consent card appears; the
// user clicks or says "ja"/"nee". What she can see is shown in a small strip,
// with a button to revoke it.
type KluisSection = { key: string; label: string }
const consentRequest = ref<KluisSection[] | null>(null)
const granted = ref<KluisSection[]>([])
let pendingConsent: KluisSection[] | null = null

const SAYS_NO = /\b(nee|neen|niet|weiger\w*|liever niet|geen toestemming)\b/i
const SAYS_YES = /\b(ja|jawel|jazeker|prima|goed|oke|oké|ok|okay|akkoord|toestaan|sta toe|mag|graag|doe maar|zeker)\b/i
const SAYS_REVOKE = /\b(intrek\w*|trek\b.*\bin\b|ingetrokken)/i

watch(state, (now, before) => {
  if (now === 'listening') playBlips(audioCtx, BLIPS.listen)
  if (now === 'thinking') playBlips(audioCtx, BLIPS.think)
  if (before === 'speaking' && now !== 'speaking' && pendingConsent) {
    consentRequest.value = pendingConsent
    pendingConsent = null
    playBlips(audioCtx, BLIPS.card)
  }
})

function answerConsent(allow: boolean) {
  const request = consentRequest.value
  if (!request) return
  consentRequest.value = null
  playBlips(audioCtx, allow ? BLIPS.allow : BLIPS.deny)
  stopSpeaking()
  if (allow) {
    const keys = new Set(granted.value.map((section) => section.key))
    granted.value = [...granted.value, ...request.filter((section) => !keys.has(section.key))]
  }
  const parts = request.map((section) => section.label.toLowerCase()).join(' en ')
  ask(allow ? `Ja, je mag mijn ${parts} bekijken.` : 'Nee, liever niet.')
}

function revokeAccess() {
  if (!granted.value.length) return
  granted.value = []
  consentRequest.value = null
  playBlips(audioCtx, BLIPS.deny)
  stopSpeaking()
  ask('Ik trek mijn toestemming in.')
}

function resetConsent() {
  consentRequest.value = null
  granted.value = []
  pendingConsent = null
}

// ---- Pixel icons ----
// While Ayla talks, the orb's blocks briefly form an icon whenever she says
// a word that has one (kluis, cv, vacature, privacy, Mistral, ...). The voice
// doesn't report word timings, so we estimate them: a word at 40% of the
// text shows its icon at 40% of the speaking time. If the answer has no such
// word, the icon Mistral picked for the whole answer is shown at the start.
type IconCue = { at: number; icon: PixelIconName; hold?: number } // at: 0..1 through the text

const ICON_WORDS: [PixelIconName, RegExp][] = [
  ['hand', /^\s*(hoi|hallo|hey|hee|goedemorgen|goedemiddag)\b|\b(doei|tot ziens|dag!)/gi],
  ['ayla', /\bayla\b/gi],
  ['europa', /\b(mistral|europ\w*|avg)\b/gi],
  ['slot', /\b(privacy|veilig\w*|beveilig\w*|afgeschermd|beschermd|gevoelige)\b/gi],
  ['toestemming', /\b(toestemming|akkoord|beslist|beslis\w*|regie)\b/gi],
  ['tijdelijk', /\b(tijdelijk\w*|intrek\w*|ingetrokken)\b/gi],
  ['kluis', /\bkluis\w*/gi],
  ['plan', /\b(plan|plannen|stappenplan|doel|doelen)\b/gi],
  ['profiel', /\bprofiel\w*/gi],
  ['cv', /\b(cv|cv's|sollicit\w*|motivatiebrief\w*)\b/gi],
  ['werk', /\b(vacature\w*|werkgever\w*|baan|banen|werkervaring|stage\w*)\b/gi],
  ['opleiding', /\b(opleiding\w*|diploma\w*|studie\w*|vmbo|mbo|hbo|universiteit)\b/gi],
  ['vaardigheden', /\b(vaardighe\w*|soft skills|talent\w*|sterke punten)\b/gi]
]
const ICON_SHOW_S = 2 // how long an icon stays
const ICON_GAP_S = 2.4 // minimum time between two icons, so it never flickers
const SPEECH_CHARS_PER_S = 15 // estimate until the full length of the audio is known

const orbIcon = ref<PixelIconName | null>(null)
let cues: IconCue[] = []
let nextCue = 0
let iconHideAt = 0
let lastIconAt = -Infinity
let waiting: { icon: PixelIconName; at: number } | null = null // cue held back by the gap
// Timing of the speech being played, filled in by playStream.
const speech = { start: 0, length: 0, complete: false, chars: 0 }

function prepareIconCues(text: string, fallback: PixelIconName | null, preset?: IconCue[]) {
  let found: IconCue[] = preset ?? []
  if (!preset) {
    for (const [icon, pattern] of ICON_WORDS) {
      for (const match of text.matchAll(pattern)) found.push({ at: match.index! / text.length, icon })
    }
    found.sort((a, b) => a.at - b.at)
    if (!found.length && fallback) found = [{ at: 0, icon: fallback }]
  }
  cues = found
  nextCue = 0
  lastIconAt = -Infinity
  waiting = null
  speech.start = 0
  speech.length = 0
  speech.complete = false
  speech.chars = text.length
}

// Called every frame: shows the icon of each word as Ayla gets to it.
function updateIcons() {
  if (state.value !== 'speaking' || !audioCtx || !speech.start) {
    if (orbIcon.value && state.value !== 'speaking') orbIcon.value = null
    return
  }
  const elapsed = audioCtx.currentTime - speech.start
  const duration = speech.complete ? speech.length : Math.max(speech.length, speech.chars / SPEECH_CHARS_PER_S)

  // Words reached since last frame; if they come too soon after the previous
  // icon, keep only the latest and show it once there's room again.
  let hold: number | undefined
  while (nextCue < cues.length && cues[nextCue]!.at * duration <= elapsed) {
    const cue = cues[nextCue++]!
    if (cue.icon === orbIcon.value) continue
    waiting = { icon: cue.icon, at: elapsed }
    hold = cue.hold
  }
  // A held-back icon that waited too long is no longer about what she says.
  if (waiting && elapsed - waiting.at > 1.5) waiting = null
  if (waiting && elapsed - lastIconAt >= ICON_GAP_S) {
    orbIcon.value = waiting.icon
    playBlips(audioCtx, BLIPS.icon)
    lastIconAt = elapsed
    iconHideAt = elapsed + (hold ?? ICON_SHOW_S)
    waiting = null
  }
  if (orbIcon.value && elapsed > iconHideAt) orbIcon.value = null
}

// ---- Demo intro ----
// Press "I": the blocks form the PAVE logo, flow into Ayla's orb, and she
// greets the audience with a short fixed line (no AI call, so nothing can go
// wrong at the start of the demo).
const INTRO_LINE = 'Hallo Daaf, hoe kan ik je vandaag helpen?'

const introActive = ref(false)
// The page starts empty: no orb, no blocks, until the intro reveals Ayla.
const revealed = ref(false)
const orbHidden = ref(true)

function startIntro() {
  if (introActive.value) return
  stopSession()
  ensureAudioContext()
  audioCtx?.resume()
  errorText.value = ''
  resetConsent()
  messages.value = [{ role: 'assistant', content: INTRO_LINE }]
  prepareIconCues(INTRO_LINE, null, [{ at: 0, icon: 'hand', hold: 3 }]) // wave while Ayla says hello
  orbHidden.value = true
  revealed.value = false
  introActive.value = true
}

// ---- Questions from the audience ----
// People scan a QR code (press Q to show it) and send a question from their
// phone. It appears on screen; the presenter presses V to let Ayla read it
// out and answer it, or X to skip it. Nothing is said without that OK.
type AudienceQuestion = { id: number; text: string; name: string }
const showQR = ref(false)
const audienceUrl = ref<string | null>(null)
const audienceError = ref('')
const audienceCount = ref(0)
const audienceNext = ref<AudienceQuestion | null>(null)
const activeAudience = ref<AudienceQuestion | null>(null)
const displayedAudience = computed(() => activeAudience.value ?? audienceNext.value)
const audienceMore = computed(() => activeAudience.value ? audienceCount.value : Math.max(0, audienceCount.value - 1))
let audienceHandling = false
let audiencePolling = false
let audienceTimer: ReturnType<typeof setInterval> | undefined

async function pollAudience() {
  if (audiencePolling) return
  audiencePolling = true
  try {
    const data = await $fetch<{ url: string | null; count: number; next: AudienceQuestion | null }>(
      '/api/audience/state', { retry: 0 }
    )
    if (data.next && data.next.id !== audienceNext.value?.id && revealed.value) playBlips(audioCtx, BLIPS.icon)
    audienceUrl.value = data.url
    audienceCount.value = data.count
    audienceNext.value = data.next
    audienceError.value = ''
  } catch (err: any) {
    audienceUrl.value = null
    audienceNext.value = null
    audienceCount.value = 0
    audienceError.value = err?.data?.statusMessage ?? 'Publieksvragen zijn even niet bereikbaar. Probeer het opnieuw.'
  } finally {
    audiencePolling = false
  }
}

async function handleAudience(action: 'take' | 'skip') {
  if (audienceHandling || state.value === 'thinking' || state.value === 'speaking' || !audienceNext.value) return
  audienceHandling = true
  const id = audienceNext.value.id
  try {
    const { question } = await $fetch<{ question: AudienceQuestion | null }>('/api/audience/next', {
      method: 'POST',
      body: { action, id },
      retry: 0
    })
    if (action === 'skip') return playBlips(audioCtx, BLIPS.deny)
    if (!question) return
    showQR.value = false
    stopSession()
    activeAudience.value = question
    // Keep this question visible until its answer has finished.
    await pollAudience()
    ensureAudioContext()
    audioCtx?.resume()
    const from = question.name ? ` van ${question.name}` : ''
    await ask(`Vraag uit de zaal${from}: ${question.text}`)
  } catch (err: any) {
    errorText.value = err?.data?.statusMessage ?? 'De vraag kon niet worden opgehaald. Probeer het opnieuw.'
  } finally {
    activeAudience.value = null
    await pollAudience()
    audienceHandling = false
  }
}

onMounted(() => {
  pollAudience()
  audienceTimer = setInterval(pollAudience, 1500)
})
onBeforeUnmount(() => clearInterval(audienceTimer))

// ---- Demo outro ----
// Press "O": Ayla says goodbye and waves, then her orb flows back into the
// PAVE logo, the page fades away and the logo dissolves block by block.
const OUTRO_LINE = 'Bedankt allemaal!'
const outroActive = ref(false)

async function startOutro() {
  if (introActive.value || outroActive.value || !revealed.value) return
  showQR.value = false
  stopSession()
  resetConsent()
  ensureAudioContext()
  audioCtx?.resume()
  messages.value.push({ role: 'assistant', content: OUTRO_LINE })
  prepareIconCues(OUTRO_LINE, null, [{ at: 0, icon: 'hand', hold: 3 }])
  await speak(OUTRO_LINE)
  orbHidden.value = true
  outroActive.value = true
}

function onOutroDone() {
  outroActive.value = false
  revealed.value = false
}

function onKey(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
  if (event.key === 'i' || event.key === 'I') startIntro()
  if (event.key === 'o' || event.key === 'O') startOutro()
  if (!revealed.value || introActive.value || outroActive.value) return
  if (event.key === 'q' || event.key === 'Q') showQR.value = !showQR.value
  if (event.key === 'v' || event.key === 'V') handleAudience('take')
  if (event.key === 'x' || event.key === 'X') handleAudience('skip')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// The orb is the only control: tap to start a conversation, tap again to
// end it (also while Ayla is listening, thinking or talking).
const orbEl = ref<HTMLElement | null>(null)

function tapOrb() {
  if (introActive.value || outroActive.value || !revealed.value) return
  if (state.value !== 'idle') stopSession()
  else if (voiceSupported.value) startSession()
  else errorText.value = 'Praten met Ayla werkt in Chrome of Edge.'
}
</script>

<template>
  <div class="screen">
    <AmbientField
      :class="{ gone: outroActive }"
      :state="state"
      :audio="audio"
      :anchor="orbEl"
      :revealed="revealed"
    />

    <main class="stage">
      <button
        ref="orbEl"
        type="button"
        class="orb"
        :class="{ hidden: orbHidden }"
        :aria-label="state === 'idle' ? 'Start gesprek met Ayla' : 'Beëindig gesprek met Ayla'"
        :tabindex="revealed ? 0 : -1"
        :aria-pressed="state !== 'idle'"
        @click="tapOrb"
      >
        <PixelOrb :state="state" :audio="audio" :icon="orbIcon" />
      </button>
      <p v-if="errorText || (showQR && audienceError)" class="error" role="alert">{{ errorText || audienceError }}</p>
    </main>

    <div v-if="revealed && !outroActive && showQR && audienceUrl" class="qr-overlay">
      <AudienceQR :url="audienceUrl" :waiting="audienceCount" />
    </div>

    <div v-if="revealed && !outroActive && displayedAudience && !showQR" class="audience-card">
      <PixelIcon name="hand" :size="22" />
      <div>
        <p class="audience-from">
          Vraag uit de zaal{{ displayedAudience.name ? ` · ${displayedAudience.name}` : '' }}
          <span v-if="audienceMore" class="audience-more">+{{ audienceMore }}</span>
        </p>
        <p class="audience-text">{{ displayedAudience.text }}</p>
      </div>
    </div>

    <div v-if="revealed && !outroActive" class="overlay">
      <ConsentCard
        v-if="consentRequest"
        :sections="consentRequest"
        @allow="answerConsent(true)"
        @deny="answerConsent(false)"
      />
      <div v-else-if="granted.length" class="access-strip">
        <PixelIcon name="kluis" :size="16" />
        <span>Ayla kan nu zien: {{ granted.map((section) => section.label).join(', ') }}</span>
        <button type="button" @click="revokeAccess">Intrekken</button>
      </div>
    </div>

    <IntroSequence
      v-if="outroActive"
      mode="outro"
      :anchor="orbEl"
      @logo="playBlips(audioCtx, BLIPS.logo)"
      @done="onOutroDone"
    />

    <IntroSequence
      v-if="introActive"
      :anchor="orbEl"
      @logo="playBlips(audioCtx, BLIPS.logo)"
      @morph="speak(INTRO_LINE)"
      @arrived="(orbHidden = false), (revealed = true)"
      @done="introActive = false"
    />
  </div>
</template>

<style>
:root {
  --green: #355e4b;
  --green-dark: #284a3a;
}
* {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  background: #ffffff;
  font-family: system-ui, -apple-system, sans-serif;
  -webkit-tap-highlight-color: transparent;
}

.screen {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom);
  overflow: hidden;
}
.stage {
  position: relative;
  z-index: 1;
}
.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

/* Ayla's orb (drawn by PixelOrb) */
.orb {
  width: min(380px, 72vw, 48dvh);
  height: min(380px, 72vw, 48dvh);
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}
.orb.hidden {
  opacity: 0;
}
.orb {
  transition: opacity 0.6s ease;
}
/* No focus ring around the orb: it showed up as a green circle during the
   demo (pressing "I" makes the browser draw focus rings). */
.orb:focus,
.orb:focus-visible {
  outline: none;
}

/* Audience questions: the QR code over everything, and the next question
   as a card at the top of the screen. */
.qr-overlay {
  position: fixed;
  inset: 0;
  z-index: 4;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(6px);
}
.audience-card {
  position: fixed;
  top: calc(4vh + env(safe-area-inset-top));
  left: 50%;
  z-index: 2;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: min(560px, calc(100vw - 32px));
  padding: 14px 18px;
  border: 1px solid #dfe7e2;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 14px 40px rgba(30, 50, 40, 0.12);
  color: var(--green);
  font-family: system-ui, -apple-system, sans-serif;
  transform: translateX(-50%);
  animation: audience-in 0.35s steps(5) both;
}
@keyframes audience-in {
  from {
    clip-path: inset(0 50% 0 50% round 18px);
  }
  to {
    clip-path: inset(0 0 0 0 round 18px);
  }
}
.audience-from {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.audience-more {
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  background: #eef3ef;
}
.audience-text {
  margin: 4px 0 0;
  color: #262a28;
  font-size: 1.1rem;
  font-weight: 600;
  line-height: 1.35;
}

/* The page fades away during the outro. */
.ambient-field {
  transition: opacity 1.4s ease;
}
.ambient-field.gone {
  opacity: 0;
}

/* Consent card and access strip, below the orb. */
.overlay {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(5vh + env(safe-area-inset-bottom));
  z-index: 2;
  display: flex;
  justify-content: center;
  padding: 0 16px;
  pointer-events: none;
}
.overlay > * {
  pointer-events: auto;
}
.access-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100vw - 32px);
  padding: 8px 8px 8px 14px;
  border: 1px solid #dfe7e2;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.92);
  color: var(--green);
  font: 600 0.85rem system-ui, -apple-system, sans-serif;
  animation: strip-in 0.3s steps(4) both;
}
.access-strip span {
  color: #262a28;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.access-strip button {
  flex: none;
  height: 30px;
  padding: 0 12px;
  border: none;
  border-radius: 999px;
  background: #eef3ef;
  color: #262a28;
  font: 600 0.8rem system-ui, -apple-system, sans-serif;
  cursor: pointer;
}
@keyframes strip-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

.error {
  margin: 0;
  max-width: 320px;
  text-align: center;
  font-size: 0.9rem;
  color: #b4441c;
}

</style>
