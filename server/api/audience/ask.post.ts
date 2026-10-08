// A phone sends a question from the audience.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ k?: string; text?: string; name?: string }>(event)
  if (!body || typeof body.k !== 'string' || typeof body.text !== 'string' ||
      (body.name !== undefined && typeof body.name !== 'string')) {
    throw createError({ statusCode: 400, statusMessage: 'Ongeldige vraag.' })
  }
  const { k, text, name } = body

  if (k !== audienceToken(event)) {
    throw createError({ statusCode: 403, statusMessage: 'Deze link werkt niet (meer).' })
  }
  const question = (text ?? '').trim().slice(0, AUDIENCE_LIMITS.maxLength)
  if (!question) throw createError({ statusCode: 400, statusMessage: 'Typ eerst een vraag.' })

  await submitAudienceQuestion(event, question, (name ?? '').trim().slice(0, AUDIENCE_LIMITS.maxNameLength))
  return { ok: true }
})
