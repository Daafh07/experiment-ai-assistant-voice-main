import { DEMO_PROFILES } from '../assistant.config'

// The demo kluizen the app can pick from. Only the label and greeting go to
// the browser; the kluis contents stay on the server.
export default defineEventHandler(() =>
  Object.entries(DEMO_PROFILES).map(([id, { label, greeting }]) => ({ id, label, greeting }))
)
