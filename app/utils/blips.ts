// Soft 8-bit style "blips" that go with the pixel blocks, generated in the
// browser (no sound files). Square waves through a low-pass filter keep them
// warm instead of harsh, and the volume is low so they never drown out Ayla.
// They go straight to the speakers, not through the analyser, so they don't
// move the orb.

type Note = { freq: number; at?: number; length?: number; volume?: number }

const MASTER_VOLUME = 0.05

export function playBlips(ctx: AudioContext | null, notes: Note[]) {
  if (!ctx || ctx.state !== 'running') return
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 2400
  filter.connect(ctx.destination)

  const now = ctx.currentTime
  for (const note of notes) {
    const start = now + (note.at ?? 0)
    const length = note.length ?? 0.07
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = note.freq
    // Quick attack, short decay: a soft "blip" instead of a click.
    const peak = MASTER_VOLUME * (note.volume ?? 1)
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(peak, start + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length)
    osc.connect(gain).connect(filter)
    osc.start(start)
    osc.stop(start + length + 0.02)
  }
}

// The sound set. Notes are from a C major pentatonic scale so they always
// sound friendly together.
export const BLIPS = {
  // Ayla starts listening: two rising notes.
  listen: [{ freq: 659 }, { freq: 988, at: 0.08 }],
  // Ayla starts thinking: a soft three-note trill.
  think: [
    { freq: 784, volume: 0.7 },
    { freq: 659, at: 0.07, volume: 0.6 },
    { freq: 784, at: 0.14, volume: 0.5 }
  ],
  // An icon forms in the orb: one tiny high blip, very quiet.
  icon: [{ freq: 1319, length: 0.05, volume: 0.45 }],
  // The consent card appears: a gentle chime.
  card: [{ freq: 784 }, { freq: 1047, at: 0.09 }, { freq: 1319, at: 0.18, length: 0.12 }],
  // Permission given: a happy rising arpeggio.
  allow: [{ freq: 659 }, { freq: 784, at: 0.07 }, { freq: 1047, at: 0.14 }, { freq: 1319, at: 0.21, length: 0.14 }],
  // Permission refused or revoked: two falling notes.
  deny: [{ freq: 523 }, { freq: 392, at: 0.1, length: 0.12 }],
  // The PAVE logo has formed (intro and outro): a little sparkle.
  logo: [
    { freq: 1047, volume: 0.6 },
    { freq: 1319, at: 0.06, volume: 0.6 },
    { freq: 1568, at: 0.12, volume: 0.6 },
    { freq: 2093, at: 0.18, length: 0.16, volume: 0.5 }
  ]
} satisfies Record<string, Note[]>
