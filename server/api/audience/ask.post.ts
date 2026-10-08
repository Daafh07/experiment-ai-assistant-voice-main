// A phone sends a question from the audience.
export default defineEventHandler(async (event) => {
  const { k, text, name } = await readBody<{ k?: string; text?: string; name?: string }>(event)

  if (k !== audience.token) {
    throw createError({ statusCode: 403, statusMessage: 'Deze link werkt niet (meer).' })
  }
  const question = (text ?? '').trim().slice(0, AUDIENCE_LIMITS.maxLength)
  if (!question) throw createError({ statusCode: 400, statusMessage: 'Typ eerst een vraag.' })

  const ip = clientIp(event)
  const last = audience.lastQuestionFrom.get(ip) ?? 0
  if (Date.now() - last < AUDIENCE_LIMITS.secondsBetweenQuestions * 1000) {
    throw createError({ statusCode: 429, statusMessage: 'Even geduld, je kunt zo weer een vraag sturen.' })
  }
  if (audience.queue.length >= AUDIENCE_LIMITS.maxQueue) {
    throw createError({ statusCode: 503, statusMessage: 'Er staan al heel veel vragen klaar. Probeer het straks nog eens.' })
  }

  audience.lastQuestionFrom.set(ip, Date.now())
  audience.queue.push({
    id: audience.nextId++,
    text: question,
    name: (name ?? '').trim().slice(0, AUDIENCE_LIMITS.maxNameLength)
  })
  console.log(`[ayla] audience question #${audience.nextId - 1}: ${question}`)
  return { ok: true }
})
