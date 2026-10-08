<script setup lang="ts">
// The demo intro and outro.
// Intro: pixel blocks fly in from the edges and form the PAVE logo, hold it
// for a moment, then flow from left to right into Ayla's orb. Emits `logo`
// when the logo has formed, `morph` when it starts turning into the orb (Ayla
// starts talking), `arrived` when the blocks are in place (the real orb takes
// over) and `done` when the intro has faded out.
// Outro: the reverse. The orb's blocks flow back into the PAVE logo, which
// holds and then dissolves block by block. Emits `logo` and `done`.
const props = withDefaults(defineProps<{ anchor: HTMLElement | null; mode?: 'intro' | 'outro' }>(), {
  mode: 'intro'
})
const emit = defineEmits<{ logo: []; morph: []; arrived: []; done: [] }>()

// Outro timeline (ms).
const OUT_LOGO = 1500 // orb has turned into the logo
const OUT_DISSOLVE = 3300 // logo starts dissolving
const OUT_END = 5300 // everything gone

const GATHER_END = 1800 // ms: blocks have formed the logo
const MORPH_START = 3200 // logo starts turning into the orb
const MORPH_END = 4600 // blocks sit where the orb's blocks are
const FADE_END = 5200 // intro gone
const LOGO_COLUMNS = 60

// Same light-to-dark greens and orb grid as PixelOrb, so the hand-over is seamless.
const PALETTE = ['#eef4f0', '#d6e8dc', '#b4d2c0', '#88b49c', '#5f8f77', '#3f6c57', '#355e4b']
const ORB_CELLS = 23
const LOGO_GREEN = '#355e4b'

type Block = {
  sx: number // start (off screen)
  sy: number
  lx: number // place in the logo
  ly: number
  ox: number // place in the orb
  oy: number
  orbColor: string
  gatherDelay: number
  dissolveDelay: number
  morphDelay: number
}

const canvas = ref<HTMLCanvasElement | null>(null)
let blocks: Block[] = []
let logoCell = 0
let orbCell = 0
let width = 0
let height = 0
let dpr = 1
let startedAt = 0
let rafId = 0
const fired = { logo: false, morph: false, arrived: false }

const ease = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const clamp = (t: number) => Math.min(1, Math.max(0, t))

// Reads the PAVE logo and returns the grid cells that are part of it.
function loadLogoCells(): Promise<{ cells: { col: number; row: number }[]; rows: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const rows = Math.round((img.height / img.width) * LOGO_COLUMNS)
      const off = document.createElement('canvas')
      off.width = LOGO_COLUMNS
      off.height = rows
      const ctx = off.getContext('2d')!
      ctx.drawImage(img, 0, 0, LOGO_COLUMNS, rows)
      const data = ctx.getImageData(0, 0, LOGO_COLUMNS, rows).data
      const cells = []
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < LOGO_COLUMNS; col++) {
          if (data[(row * LOGO_COLUMNS + col) * 4 + 3]! > 110) cells.push({ col, row })
        }
      }
      resolve({ cells, rows })
    }
    img.onerror = reject
    img.src = '/pave-logo.png'
  })
}

async function setup() {
  const el = canvas.value
  if (!el) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = window.innerWidth
  height = window.innerHeight
  el.width = Math.round(width * dpr)
  el.height = Math.round(height * dpr)

  const rect = props.anchor?.getBoundingClientRect()
  const cx = rect ? rect.left + rect.width / 2 : width / 2
  const cy = rect ? rect.top + rect.height / 2 : height / 2
  const orbSize = rect?.width ?? 300

  // Orb targets: the same grid PixelOrb draws.
  orbCell = orbSize / ORB_CELLS
  const c = (ORB_CELLS - 1) / 2
  const orbTargets: { x: number; y: number; color: string }[] = []
  for (let i = 0; i < ORB_CELLS; i++) {
    for (let j = 0; j < ORB_CELLS; j++) {
      const x = (i - c) / c
      const y = (j - c) / c
      const r = Math.hypot(x, y)
      if (r > 0.84) continue
      const v = Math.min(1, Math.max(0, 0.62 - r * 0.35 + (y - x) * 0.12))
      orbTargets.push({
        x: cx - orbSize / 2 + (i + 0.5) * orbCell,
        y: cy - orbSize / 2 + (j + 0.5) * orbCell,
        color: PALETTE[Math.min(PALETTE.length - 1, Math.floor(v * PALETTE.length))]!
      })
    }
  }
  orbTargets.sort((a, b) => a.x - b.x || a.y - b.y)

  // Logo targets, centred on the orb.
  const { cells, rows } = await loadLogoCells()
  const logoWidth = Math.min(width * 0.72, 820)
  logoCell = logoWidth / LOGO_COLUMNS
  const left = cx - logoWidth / 2
  const top = cy - (rows * logoCell) / 2
  cells.sort((a, b) => a.col - b.col || a.row - b.row)

  const far = Math.hypot(width, height) * 0.6
  blocks = cells.map((cell, k) => {
    const target = orbTargets[Math.floor((k / cells.length) * orbTargets.length)]!
    const angle = Math.random() * Math.PI * 2
    return {
      sx: cx + Math.cos(angle) * far,
      sy: cy + Math.sin(angle) * far,
      lx: left + (cell.col + 0.5) * logoCell,
      ly: top + (cell.row + 0.5) * logoCell,
      ox: target.x,
      oy: target.y,
      orbColor: target.color,
      gatherDelay: Math.random() * 600,
      dissolveDelay: Math.random() * 1500,
      // Sweep from left to right, like reading the logo.
      morphDelay: (cell.col / LOGO_COLUMNS) * 500
    }
  })

  startedAt = performance.now()
  rafId = requestAnimationFrame(draw)
}

function draw(now: number) {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx) return
  if (props.mode === 'outro') return drawOutro(ctx, now - startedAt)
  const t = now - startedAt

  if (t >= GATHER_END && !fired.logo) {
    fired.logo = true
    emit('logo')
  }
  if (t >= MORPH_START && !fired.morph) {
    fired.morph = true
    emit('morph')
  }
  if (t >= MORPH_END && !fired.arrived) {
    fired.arrived = true
    emit('arrived')
  }
  if (t >= FADE_END) {
    emit('done')
    return
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.globalAlpha = t > MORPH_END ? 1 - (t - MORPH_END) / (FADE_END - MORPH_END) : 1

  for (const b of blocks) {
    let x: number
    let y: number
    let size: number
    let color = LOGO_GREEN
    if (t < MORPH_START) {
      // Fly in and form the logo, with a soft shimmer while it holds.
      const p = ease(clamp((t - b.gatherDelay) / (GATHER_END - 600)))
      x = b.sx + (b.lx - b.sx) * p
      y = b.sy + (b.ly - b.sy) * p
      size = logoCell * 0.82
      if (p === 0) continue
    } else {
      // Flow from the logo into the orb.
      const q = easeInOut(clamp((t - MORPH_START - b.morphDelay) / (MORPH_END - MORPH_START - 500)))
      x = b.lx + (b.ox - b.lx) * q
      y = b.ly + (b.oy - b.ly) * q
      size = logoCell * 0.82 + (orbCell * 0.84 - logoCell * 0.82) * q
      if (q > 0.5) color = b.orbColor
    }
    ctx.fillStyle = color
    ctx.fillRect(x - size / 2, y - size / 2, size, size)
  }
  ctx.globalAlpha = 1

  rafId = requestAnimationFrame(draw)
}

function drawOutro(ctx: CanvasRenderingContext2D, t: number) {
  if (t >= OUT_LOGO && !fired.logo) {
    fired.logo = true
    emit('logo')
  }
  if (t >= OUT_END) {
    emit('done')
    return
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  for (const b of blocks) {
    // Flow from the orb into the logo, sweeping from left to right.
    const q = easeInOut(clamp((t - b.morphDelay) / (OUT_LOGO - 500)))
    const x = b.ox + (b.lx - b.ox) * q
    const y = b.oy + (b.ly - b.oy) * q
    const size = orbCell * 0.84 + (logoCell * 0.82 - orbCell * 0.84) * q
    // Then the logo dissolves, block by block.
    const alpha = 1 - clamp((t - OUT_DISSOLVE - b.dissolveDelay) / 400)
    if (alpha <= 0) continue
    ctx.globalAlpha = alpha
    ctx.fillStyle = q > 0.5 ? LOGO_GREEN : b.orbColor
    ctx.fillRect(x - size / 2, y - size / 2, size, size)
  }
  ctx.globalAlpha = 1

  rafId = requestAnimationFrame(draw)
}

onMounted(() => {
  // With reduced motion there is no animation: hand over straight away.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    emit('morph')
    emit('arrived')
    emit('done')
    return
  }
  setup().catch(() => {
    // Logo could not be loaded: skip the animation but keep the intro speech.
    emit('morph')
    emit('arrived')
    emit('done')
  })
})

onBeforeUnmount(() => cancelAnimationFrame(rafId))
</script>

<template>
  <canvas ref="canvas" class="intro-sequence" aria-hidden="true" />
</template>

<style>
.intro-sequence {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 3;
}
</style>
