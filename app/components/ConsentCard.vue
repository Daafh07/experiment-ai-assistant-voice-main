<script setup lang="ts">
// The consent card: Ayla asks to look at specific parts of the kluis, and
// nothing happens until the user allows or refuses (by clicking, or by
// saying "ja" or "nee"). It builds up from the centre in pixel steps.
defineProps<{ sections: { key: string; label: string }[] }>()
defineEmits<{ allow: []; deny: [] }>()
</script>

<template>
  <div class="consent" role="dialog" aria-label="Ayla vraagt toestemming">
    <div class="consent-head">
      <PixelIcon name="kluis" :size="30" />
      <div>
        <p class="consent-title">Ayla wil in je kluis kijken</p>
        <p class="consent-sub">Alleen voor deze vraag. Je kunt het altijd intrekken.</p>
      </div>
    </div>

    <ul class="consent-sections">
      <li v-for="section in sections" :key="section.key">
        <PixelIcon name="toestemming" :size="12" />
        {{ section.label }}
      </li>
    </ul>

    <div class="consent-actions">
      <button type="button" class="deny" @click="$emit('deny')">Weigeren</button>
      <button type="button" class="allow" @click="$emit('allow')">Toestaan</button>
    </div>
    <p class="consent-hint">of zeg "ja" of "nee"</p>
  </div>
</template>

<style>
.consent {
  --green: #355e4b;
  width: min(400px, calc(100vw - 32px));
  padding: 18px 18px 12px;
  border: 1px solid #dfe7e2;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 18px 50px rgba(30, 50, 40, 0.14);
  color: #262a28;
  font-family: system-ui, -apple-system, sans-serif;
  /* Builds up from the centre in pixel-like steps. */
  animation: consent-in 0.45s steps(6) both;
}
@keyframes consent-in {
  from {
    clip-path: inset(45% 45% 45% 45% round 18px);
    opacity: 0;
  }
  to {
    clip-path: inset(0 0 0 0 round 18px);
    opacity: 1;
  }
}
.consent-head {
  display: flex;
  align-items: center;
  gap: 14px;
  color: var(--green);
}
.consent-title {
  margin: 0;
  font-weight: 700;
  font-size: 1.05rem;
  color: #262a28;
}
.consent-sub {
  margin: 2px 0 0;
  font-size: 0.82rem;
  color: #6b736e;
}
.consent-sections {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 14px 0 16px;
  padding: 0;
  list-style: none;
}
.consent-sections li {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 11px;
  border-radius: 10px;
  background: #eef3ef;
  color: var(--green);
  font-size: 0.88rem;
  font-weight: 600;
}
.consent-actions {
  display: flex;
  gap: 10px;
}
.consent-actions button {
  flex: 1;
  height: 44px;
  border: none;
  border-radius: 12px;
  font: 600 0.95rem system-ui, -apple-system, sans-serif;
  cursor: pointer;
  transition: transform 0.12s ease, background 0.2s ease;
}
.consent-actions button:active {
  transform: scale(0.97);
}
.consent-actions .allow {
  background: var(--green);
  color: #fff;
}
.consent-actions .deny {
  background: #eef3ef;
  color: #262a28;
}
@media (hover: hover) {
  .consent-actions .allow:hover {
    background: #2c513f;
  }
  .consent-actions .deny:hover {
    background: #e2eae5;
  }
}
.consent-hint {
  margin: 8px 0 0;
  text-align: center;
  font-size: 0.75rem;
  color: #9aa19d;
}
@media (prefers-reduced-motion: reduce) {
  .consent {
    animation: none;
  }
}
</style>
