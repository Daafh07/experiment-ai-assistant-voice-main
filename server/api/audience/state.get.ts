// For the presenter's screen: the QR link and the waiting questions.
export default defineEventHandler((event) => {
  if (!isPresenter(event)) throw createError({ statusCode: 403 })

  // A public address (for example a tunnel) wins over the local Wi-Fi address.
  const publicUrl = useRuntimeConfig().publicUrl as string | undefined
  const port = getRequestHost(event).split(':')[1] ?? '3001'
  const lan = lanAddress()
  const base = publicUrl?.replace(/\/$/, '') || (lan ? `http://${lan}:${port}` : null)

  return {
    url: base ? `${base}/vraag?k=${audience.token}` : null,
    count: audience.queue.length,
    next: audience.queue[0] ?? null
  }
})
