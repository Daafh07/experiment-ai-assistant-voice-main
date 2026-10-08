<script setup lang="ts">
// One of Ayla's pixel icons as a small grid of blocks, for use outside the
// orb (the consent card, the access strip). The blocks pop in one by one.
import { PIXEL_ICONS, type PixelIconName } from '~/utils/pixelIcons'

const props = withDefaults(defineProps<{ name: PixelIconName; size?: number }>(), { size: 26 })

const cells = computed(() =>
  PIXEL_ICONS[props.name].flatMap((row, y) =>
    [...row].map((ch, x) => ({ on: ch === '#', delay: ((x * 7 + y * 13) % 17) * 18 }))
  )
)
</script>

<template>
  <span
    class="pixel-icon"
    :style="{ width: `${size}px`, height: `${size}px`, gap: size < 20 ? '0' : '1px' }"
    aria-hidden="true"
  >
    <span
      v-for="(cell, i) in cells"
      :key="i"
      class="px"
      :class="{ on: cell.on }"
      :style="{ animationDelay: `${cell.delay}ms` }"
    />
  </span>
</template>

<style>
.pixel-icon {
  display: inline-grid;
  grid-template-columns: repeat(13, 1fr);
  gap: 1px;
  flex: none;
}
.pixel-icon .px.on {
  background: currentColor;
  animation: px-pop 0.25s steps(2) both;
}
@keyframes px-pop {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pixel-icon .px.on {
    animation: none;
  }
}
</style>
