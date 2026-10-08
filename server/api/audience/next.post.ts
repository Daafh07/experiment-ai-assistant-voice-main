// The presenter takes (V) or skips (X) the next audience question.
export default defineEventHandler(async (event) => {
  if (!isPresenter(event)) throw createError({ statusCode: 403 })
  const body = await readBody<{ action?: 'take' | 'skip'; id?: number }>(event)
  if (!body || !['take', 'skip'].includes(body.action ?? '') || !Number.isInteger(body.id)) {
    throw createError({ statusCode: 400, statusMessage: 'Ongeldige vraag of actie.' })
  }
  const { action, id } = body
  // Only remove the question the presenter actually saw. A duplicate or
  // delayed request must never consume the following question.
  if (audience.queue[0]?.id !== id) {
    throw createError({ statusCode: 409, statusMessage: 'Deze vraag is al behandeld. De wachtrij wordt vernieuwd.' })
  }
  const question = audience.queue.shift() ?? null
  if (question) console.log(`[ayla] audience question #${question.id} ${action === 'skip' ? 'skipped' : 'answered'}`)
  return { question: action === 'skip' ? null : question }
})
