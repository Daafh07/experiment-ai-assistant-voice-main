<script setup lang="ts">
import { PIXEL_ICONS, type PixelIconName } from '~/utils/pixelIcons'

// Ayla's orb, drawn as a round field of square pixel blocks in the PAVE
// greens (the same blocky style as Ayla's stepped slash mark). Each voice
// state moves the blocks differently. `audio.level` (0..1) is the loudness
// of whoever is talking: you while she listens, Ayla while she speaks.
// `icon` makes the blocks briefly form a pixel icon (kluis, plan, profiel,
// slot) and then flow back into the orb.
const props = defineProps<{
  state: 'idle' | 'listening' | 'thinking' | 'speaking'
  audio: { level: number; bands: Float32Array }
  icon?: PixelIconName | null
}>()

// Light to dark PAVE greens.
const PALETTE = ['#eef4f0', '#d6e8dc', '#b4d2c0', '#88b49c', '#5f8f77', '#3f6c57', '#355e4b']

const canvas = ref<HTMLCanvasElement | null>(null)
let rafId = 0
let observer: ResizeObserver | null = null
let size = 0
let dpr = 1

// Smoothed per-state weights, so switching state blends instead of jumping.
const mix = { idle: 1, listening: 0, thinking: 0, speaking: 0 }
let smoothLevel = 0
let listenPhase = 0 // advances faster while you talk, without jumps
let lastNow = 0
let iconMix = 0 // 0 = orb, 1 = icon fully formed
let shownIcon: PixelIconName | null = null // stays set while the icon fades out

// Stable pseudo-random value per block.
function hash(i: number, j: number) {
  const x = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453
  return x - Math.floor(x)
}

function resize() {
  const el = canvas.value
  if (!el) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  size = el.clientWidth
  el.width = Math.round(size * dpr)
  el.height = Math.round(size * dpr)
}

function draw(now: number) {
  const el = canvas.value
  const ctx = el?.getContext('2d')
  if (!el || !ctx || !size) {
    rafId = requestAnimationFrame(draw)
    return
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const t = reduced ? 0 : now / 1000

  for (const key of Object.keys(mix) as (keyof typeof mix)[]) {
    mix[key] += ((props.state === key ? 1 : 0) - mix[key]) * 0.08
  }
  smoothLevel += (props.audio.level - smoothLevel) * 0.35
  const dt = lastNow ? Math.min((now - lastNow) / 1000, 0.1) : 0
  lastNow = now
  if (!reduced) listenPhase += dt * (4.5 + smoothLevel * 6)

  if (props.icon) shownIcon = props.icon
  iconMix += ((props.icon ? 1 : 0) - iconMix) * (reduced ? 1 : 0.12)
  if (iconMix < 0.01 && !props.icon) shownIcon = null
  const iconRows = shownIcon ? PIXEL_ICONS[shownIcon] : null

  const { idle, listening, thinking, speaking } = mix
  const cells = 23
  const cell = size / cells
  const gap = Math.max(1, cell * 0.16)
  const c = (cells - 1) / 2

  // The orb's outline: breathes while listening and leans in when you
  // talk, swells with Ayla's voice.
  const radius =
    0.86 +
    listening * (0.04 * Math.sin(t * 2.6) + smoothLevel * 0.08) +
    thinking * 0.03 * Math.sin(t * 5) +
    speaking * smoothLevel * 0.14

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size, size)

  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const x = (i - c) / c // -1..1
      const y = (j - c) / c
      const r = Math.hypot(x, y)
      const h = hash(i, j)

      // Ragged, slowly flickering edge so the circle feels alive.
      const edge = radius + (h - 0.5) * 0.14 + 0.04 * Math.sin(t * 1.3 + h * 20)
      if (r > edge) continue

      // Base tone: darker towards the lower left, like Ayla's slash.
      let v = 0.62 - r * 0.35 + (y - x) * 0.12
      // Idle: blocks twinkle softly at their own pace.
      v += idle * 0.16 * Math.sin(t * 1.1 + h * Math.PI * 2)
      // Listening: rings flowing inwards, faster and stronger as you talk.
      v += listening * (0.22 + smoothLevel * 0.4) * Math.sin(r * 9 + listenPhase)
      // Thinking: a diagonal sweep along the slash direction.
      v += thinking * 0.4 * Math.sin((x + y) * 4 + t * 7)
      // Speaking: pulses from the centre, driven by the voice.
      v += speaking * (0.15 + smoothLevel * 0.55) * Math.sin(r * 11 - t * 11)
      v += speaking * smoothLevel * 0.25 * (1 - r)

      // Icon: blocks switch to dark (in the icon) or very light (around it),
      // each at a slightly different moment so it assembles block by block.
      if (iconRows) {
        const offset = (cells - iconRows.length) / 2
        // The hand waves: it shifts one block left and right.
        const wave = shownIcon === 'hand' && !reduced ? Math.round(Math.sin(t * 7)) : 0
        const row = iconRows[j - offset]
        const inIcon = row?.[i - offset - wave] === '#'
        const local = Math.min(1, Math.max(0, iconMix * 1.6 - h * 0.6))
        v = v + ((inIcon ? 1 : 0.05) - v) * local
      }

      v = Math.min(1, Math.max(0, v))
      const idx = Math.min(PALETTE.length - 1, Math.floor(v * PALETTE.length))
      // Blocks near the edge fade a little for a softer silhouette.
      ctx.globalAlpha = Math.min(1, Math.max(0.25, (edge - r) * 7))
      ctx.fillStyle = PALETTE[idx]!
      ctx.fillRect(i * cell + gap / 2, j * cell + gap / 2, cell - gap, cell - gap)
    }
  }
  ctx.globalAlpha = 1

  rafId = requestAnimationFrame(draw)
}

onMounted(() => {
  resize()
  observer = new ResizeObserver(resize)
  if (canvas.value) observer.observe(canvas.value)
  rafId = requestAnimationFrame(draw)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  observer?.disconnect()
})
</script>

<template>
  <canvas ref="canvas" class="pixel-orb" aria-hidden="true" />
</template>

<style>
.pixel-orb {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
