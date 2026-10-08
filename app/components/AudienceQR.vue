<script setup lang="ts">
// The big QR code for audience questions, drawn as PAVE-green pixel blocks
// that pop in one by one. Phones that scan it open the question page.
import { encode } from 'uqr'

const props = defineProps<{ url: string; waiting: number }>()

const qr = computed(() => encode(props.url, { border: 1 }))
const modules = computed(() =>
  qr.value.data.flatMap((row, y) =>
    row.map((on, x) => ({ on, delay: on ? Math.floor(((x * 37 + y * 53) % 97) * 7) : 0 }))
  )
)
// The short address opens the current audience session without a query code.
const shortUrl = computed(() => {
  const url = new URL(props.url)
  return `${url.host}${url.pathname}`
})
</script>

<template>
  <div class="audience-qr" role="dialog" aria-label="Stel Ayla een vraag via je telefoon">
    <p class="qr-title"><PixelIcon name="ayla" :size="28" />Stel Ayla een vraag</p>
    <div class="qr-grid" :style="{ gridTemplateColumns: `repeat(${qr.size}, 1fr)` }" aria-hidden="true">
      <span
        v-for="(m, i) in modules"
        :key="i"
        :class="{ on: m.on }"
        :style="m.on ? { animationDelay: `${m.delay}ms` } : undefined"
      />
    </div>
    <p class="qr-sub">Scan met de camera van je telefoon</p>
    <p class="qr-fallback">Scannen lukt niet? Typ dit in je browser:</p>
    <p class="qr-url">{{ shortUrl }}</p>
    <p v-if="waiting" class="qr-waiting">{{ waiting }} {{ waiting === 1 ? 'vraag' : 'vragen' }} binnen</p>
  </div>
</template>

<style>
.audience-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 26px 30px 22px;
  border: 1px solid #dfe7e2;
  border-radius: 24px;
  background: #fff;
  box-shadow: 0 24px 70px rgba(30, 50, 40, 0.16);
  color: #262a28;
  font-family: system-ui, -apple-system, sans-serif;
  animation: qr-in 0.4s steps(5) both;
}
@keyframes qr-in {
  from {
    clip-path: inset(46% 46% 46% 46% round 24px);
  }
  to {
    clip-path: inset(0 0 0 0 round 24px);
  }
}
.qr-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 6px;
  font-size: clamp(1.3rem, 3vw, 1.9rem);
  font-weight: 800;
}
.qr-grid {
  display: grid;
  width: min(56vh, 70vw, 440px);
  aspect-ratio: 1;
  gap: 1px;
}
.qr-grid span.on {
  background: #355e4b;
  animation: px-pop 0.2s steps(2) both;
}
.qr-sub {
  margin: 6px 0 0;
  font-weight: 600;
}
.qr-fallback {
  margin: 6px 0 0;
  font-size: 0.9rem;
  color: #6b736e;
}
.qr-url {
  margin: 0;
  max-width: min(70vw, 440px);
  overflow-wrap: anywhere;
  text-align: center;
  font-size: clamp(1.1rem, 3vw, 1.5rem);
  font-weight: 800;
  color: #355e4b;
}
.qr-waiting {
  margin: 4px 0 0;
  padding: 5px 12px;
  border-radius: 999px;
  background: #eef3ef;
  color: #355e4b;
  font-size: 0.85rem;
  font-weight: 700;
}
@media (prefers-reduced-motion: reduce) {
  .audience-qr,
  .qr-grid span.on {
    animation: none;
  }
}
</style>
