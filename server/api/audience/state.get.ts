// For the presenter's screen: the QR link and the waiting questions.
export default defineEventHandler(async (event) => {
  if (!isPresenter(event)) throw createError({ statusCode: 403 })

  // A public address (for example a tunnel) wins over the local Wi-Fi address.
  const config = useRuntimeConfig(event)
  const publicUrl = config.publicUrl as string | undefined
  const port = getRequestHost(event).split(':')[1] ?? '3001'
  const lan = lanAddress()
  const base = publicUrl?.replace(/\/$/, '') ||
    (config.audienceHosted ? getRequestURL(event).origin : lan ? `http://${lan}:${port}` : null)
  const state = await audienceState(event)

  return {
    url: base ? `${base}/vraag` : null,
    ...state
  }
})
