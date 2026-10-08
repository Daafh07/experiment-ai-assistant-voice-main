<script setup lang="ts">
// The page around Ayla's orb, made of small pixel blocks, so the whole page
// plays along with her:
// - a soft glow and waves across a block grid (in while listening, diagonal
//   while thinking, out while speaking, an odd twinkle when idle);
// - a ring of blocks around the orb that follows the voice like an
//   equalizer (your voice while she listens, hers while she speaks);
// - loose blocks flying around: drawn in from the edges while you talk,
//   spiralling in while she thinks, thrown out on the rhythm of her voice.
// Until `revealed` is true the page stays empty; then everything appears in
// a wave of blocks rolling out from the orb.
const props = defineProps<{
  state: 'idle' | 'listening' | 'thinking' | 'speaking'
  audio: { level: number; bands: Float32Array }
  anchor: HTMLElement | null // the orb; everything is centred on it
  revealed: boolean
}>()

const REVEAL_MS = 1600

const GREEN = [53, 94, 75] // #355e4b
const SAGE = [95, 143, 119] // #5f8f77, used for the user's voice
const MAX_PARTICLES = 320

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  angle: number // for orbiting blocks
  radius: number
  life: number // 1 → 0
  decay: number
  size: number
  kind: 'in' | 'orbit' | 'out' | 'drift'
}

const canvas = ref<HTMLCanvasElement | null>(null)
let rafId = 0
let width = 0
let height = 0
let dpr = 1
let cx = 0
let cy = 0
let orbRadius = 0
let lastNow = 0
let lastState = props.state
let revealStart = 0 // when the reveal wave started (0 = not yet)
const particles: Particle[] = []

const mix = { idle: 1, listening: 0, thinking: 0, speaking: 0 }
let smoothLevel = 0

function hash(i: number, j: number) {
  const x = Math.sin(i * 127.1 + j * 311.7) * 43758.5453
  return x - Math.floor(x)
}

function measure() {
  const el = canvas.value
  if (!el) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = window.innerWidth
  height = window.innerHeight
  el.width = Math.round(width * dpr)
  el.height = Math.round(height * dpr)
  const rect = props.anchor?.getBoundingClientRect()
  cx = rect ? rect.left + rect.width / 2 : width / 2
  cy = rect ? rect.top + rect.height / 2 : height / 2
  orbRadius = rect ? (rect.width / 2) * 0.86 : 0
}

function spawn(kind: Particle['kind'], speed = 1) {
  if (particles.length >= MAX_PARTICLES) return
  const reach = Math.hypot(width, height) / 2
  const a = Math.random() * Math.PI * 2
  const p: Particle = { x: 0, y: 0, vx: 0, vy: 0, angle: a, radius: 0, life: 1, decay: 0, size: 0, kind }
  if (kind === 'in' || kind === 'drift') {
    // From somewhere far out, heading for the orb.
    const r = reach * (0.75 + Math.random() * 0.35)
    p.x = cx + Math.cos(a) * r
    p.y = cy + Math.sin(a) * r
    const s = (kind === 'drift' ? 0.35 : 2.2) * speed
    p.vx = -Math.cos(a) * s
    p.vy = -Math.sin(a) * s
    p.decay = kind === 'drift' ? 0.0015 : 0.006
    p.size = kind === 'drift' ? 5 : 4 + Math.random() * 4
  } else if (kind === 'orbit') {
    p.radius = orbRadius * (1.5 + Math.random() * 1.1)
    p.decay = 0.004 + Math.random() * 0.004
    p.size = 4 + Math.random() * 4
  } else {
    // Thrown out from the edge of the orb.
    p.x = cx + Math.cos(a) * orbRadius
    p.y = cy + Math.sin(a) * orbRadius
    const s = (2 + Math.random() * 2) * speed
    p.vx = Math.cos(a) * s
    p.vy = Math.sin(a) * s
    p.decay = 0.008 + Math.random() * 0.006
    p.size = 4 + Math.random() * 5
  }
  particles.push(p)
}

// A short burst of blocks whenever Ayla switches state, so each change is felt.
function burst(state: typeof props.state) {
  if (state === 'thinking') for (let i = 0; i < 28; i++) spawn('orbit')
  if (state === 'listening') for (let i = 0; i < 24; i++) spawn('in', 1.4)
}

function updateParticles(dt: number) {
  const { idle, listening, thinking, speaking } = mix
  const lvl = smoothLevel

  // Spawn rates per frame (60 fps), scaled by state and voice.
  const rates = [
    ['drift', idle * 0.03],
    ['in', listening * (0.15 + lvl * 4)],
    ['orbit', thinking * 1.2],
    ['out', speaking * lvl * 0.6]
  ] as const
  for (const [kind, rate] of rates) {
    let n = rate * dt
    while (n > 0) {
      if (Math.random() < n) spawn(kind, kind === 'in' ? 1 + lvl * 2 : kind === 'out' ? 1 + lvl * 2 : 1)
      n -= 1
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!
    if (p.kind === 'orbit') {
      // Spiral in towards the orb.
      p.angle += 0.035 * dt
      p.radius -= 0.9 * dt
      p.x = cx + Math.cos(p.angle) * p.radius
      p.y = cy + Math.sin(p.angle) * p.radius
      if (p.radius < orbRadius) p.life = 0
    } else {
      if (p.kind === 'in') {
        // Pulled harder the closer it gets.
        const dx = cx - p.x
        const dy = cy - p.y
        const d = Math.hypot(dx, dy) || 1
        p.vx += (dx / d) * 0.06 * dt
        p.vy += (dy / d) * 0.06 * dt
      }
      if (p.kind === 'out') {
        p.vx *= 1 - 0.01 * dt
        p.vy *= 1 - 0.01 * dt
      }
      p.x += p.vx * dt
      p.y += p.vy * dt
      // Swallowed by the orb.
      if ((p.kind === 'in' || p.kind === 'drift') && Math.hypot(p.x - cx, p.y - cy) < orbRadius) p.life = 0
    }
    p.life -= p.decay * dt
    if (p.life <= 0 || p.x < -20 || p.y < -20 || p.x > width + 20 || p.y > height + 20) particles.splice(i, 1)
  }
}

function draw(now: number) {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx || !width) {
    rafId = requestAnimationFrame(draw)
    return
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const t = reduced ? 0 : now / 1000
  const dt = lastNow ? Math.min((now - lastNow) / 16.67, 3) : 1
  lastNow = now

  for (const key of Object.keys(mix) as (keyof typeof mix)[]) {
    mix[key] += ((props.state === key ? 1 : 0) - mix[key]) * 0.05
  }
  smoothLevel += (props.audio.level - smoothLevel) * 0.3
  const { idle, listening, thinking, speaking } = mix

  if (props.state !== lastState) {
    if (!reduced) burst(props.state)
    lastState = props.state
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  // Nothing on the page until the intro reveals it.
  if (!props.revealed) {
    revealStart = 0
    particles.length = 0
    rafId = requestAnimationFrame(draw)
    return
  }
  if (!revealStart) revealStart = now
  const revealT = reduced ? 1 : Math.min(1, (now - revealStart) / REVEAL_MS)
  const reveal = 1 - Math.pow(1 - revealT, 3) // ease out

  // Soft green glow around the orb; brighter when active, pulsing with the voice.
  const glow =
    (listening * (0.08 + smoothLevel * 0.08) + thinking * 0.08 + speaking * (0.1 + smoothLevel * 0.14)) * reveal
  if (glow > 0.003) {
    const g = ctx.createRadialGradient(cx, cy, orbRadius * 0.3, cx, cy, Math.max(width, height) * 0.6)
    g.addColorStop(0, `rgba(${GREEN}, ${glow})`)
    g.addColorStop(1, `rgba(${GREEN}, 0)`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, width, height)
  }

  // Block grid, aligned on the orb's centre so rings stay symmetric.
  const cell = width < 600 ? 18 : 24
  const block = cell * 0.36
  const reach = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy))
  const i0 = -Math.ceil(cx / cell)
  const i1 = Math.ceil((width - cx) / cell)
  const j0 = -Math.ceil(cy / cell)
  const j1 = Math.ceil((height - cy) / cell)
  // The reveal wave: a ring of blocks rolling out from the orb to the corners.
  const waveRadius = reveal * reach * 1.1
  const waveWidth = 70

  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const x = cx + i * cell
      const y = cy + j * cell
      const d = Math.hypot(x - cx, y - cy)
      if (d < orbRadius * 1.6) continue // keep room for the orb and its ring
      if (d > waveRadius) continue // not revealed yet
      const h = hash(i, j)
      const far = d / reach

      // The front of the reveal wave lights up as it passes.
      let a = revealT < 1 ? Math.max(0, 1 - Math.abs(d - waveRadius) / waveWidth) * 0.45 * (0.5 + h * 0.5) : 0

      // Idle: an occasional block twinkles.
      a += idle * Math.max(0, Math.sin(t * 0.5 + h * 60) - 0.93) * 2.2

      // Listening: rings travelling in towards the orb, stronger as you talk.
      const inward = Math.pow(Math.max(0, Math.sin(d / 70 + t * 3.2)), 10)
      a += listening * inward * (0.08 + far * 0.3) * (0.6 + smoothLevel * 1.2)

      // Thinking: diagonal bands along Ayla's slash, sweeping across the page.
      const diag = Math.pow(Math.max(0, Math.sin((x - cx + (y - cy)) / 140 + t * 3.5)), 12)
      a += thinking * diag * 0.3 * (0.6 + h * 0.4)

      // Speaking: rings travelling out from the orb, carried by her voice.
      const outward = Math.pow(Math.max(0, Math.sin(d / 55 - t * 6)), 8)
      a += speaking * outward * (0.06 + smoothLevel * 0.5) * (1 - far * 0.8)

      if (a < 0.01) continue
      ctx.fillStyle = `rgba(${GREEN}, ${Math.min(a, 0.55)})`
      ctx.fillRect(x - block / 2, y - block / 2, block, block)
    }
  }

  // Equalizer ring around the orb: columns of blocks per frequency band,
  // mirrored left/right. Sage for your voice, dark green for Ayla's.
  const ringWeight = Math.max(listening, speaking) * reveal
  if (ringWeight > 0.02) {
    const bands = props.audio.bands
    const n = bands.length
    const segments = n * 2
    const step = cell * 0.55
    const size = cell * 0.36
    const color = speaking > listening ? GREEN : SAGE
    for (let k = 0; k < segments; k++) {
      // Mirror so low tones sit at the bottom on both sides.
      const band = k < n ? k : segments - 1 - k
      const value = bands[band]! * ringWeight
      const count = Math.min(8, Math.round(value * 10))
      const angle = Math.PI / 2 + (k / segments) * Math.PI * 2
      for (let b = 0; b < count; b++) {
        const r = orbRadius * 1.2 + b * step
        const x = cx + Math.cos(angle) * r
        const y = cy + Math.sin(angle) * r
        ctx.fillStyle = `rgba(${color}, ${0.8 - (b / 8) * 0.55})`
        ctx.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size)
      }
    }
  }

  // Loose blocks (once the page is revealed).
  if (!reduced && revealT >= 1) {
    updateParticles(dt)
    for (const p of particles) {
      const color = p.kind === 'in' && listening > speaking ? SAGE : GREEN
      const alpha = Math.min(1, p.life * 1.4) * (p.kind === 'drift' ? 0.35 : 0.7)
      ctx.fillStyle = `rgba(${color}, ${alpha})`
      // Snap to a small grid so the blocks stay crisp and pixel-like.
      ctx.fillRect(Math.round(p.x / 2) * 2 - p.size / 2, Math.round(p.y / 2) * 2 - p.size / 2, p.size, p.size)
    }
  }

  rafId = requestAnimationFrame(draw)
}

watch(() => props.anchor, measure)

onMounted(() => {
  measure()
  window.addEventListener('resize', measure)
  rafId = requestAnimationFrame(draw)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  window.removeEventListener('resize', measure)
})
</script>

<template>
  <canvas ref="canvas" class="ambient-field" aria-hidden="true" />
</template>

<style>
.ambient-field {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}
</style>
