// The phone page behind the QR code: a small PAVE-styled form to send Ayla a
// question. Plain HTML so it loads instantly on any phone.
export default defineEventHandler((event) => {
  const { k } = getQuery(event)
  // The short address opens the current session; old QR links with an
  // explicit token still have to match, so expired links remain invalid.
  const valid = k === undefined || k === audience.token
  setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'no-store')

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<title>Stel Ayla een vraag · PAVE</title>
<style>
  :root { --green: #355e4b; --soft: #eef3ef; --text: #262a28; --muted: #6b736e; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; background: #fff; color: var(--text);
    font-family: system-ui, -apple-system, sans-serif;
    display: flex; justify-content: center;
    padding: max(28px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
    -webkit-tap-highlight-color: transparent;
  }
  main { width: 100%; max-width: 440px; display: flex; flex-direction: column; gap: 18px; }
  .logo { height: 30px; align-self: flex-start; }
  h1 { margin: 6px 0 0; font-size: 1.6rem; line-height: 1.2; }
  .mark { display: inline-block; width: 0.55em; height: 0.85em; margin-right: 0.3em; vertical-align: -0.05em;
    background: linear-gradient(var(--green), var(--green)) 64% 0 / 36% 30% no-repeat,
                linear-gradient(var(--green), var(--green)) 45% 34% / 36% 30% no-repeat,
                linear-gradient(var(--green), var(--green)) 18% 66% / 36% 30% no-repeat,
                linear-gradient(var(--green), var(--green)) 0 100% / 36% 30% no-repeat; }
  p { margin: 0; color: var(--muted); line-height: 1.45; }
  label { font-weight: 600; font-size: 0.9rem; display: block; margin-bottom: 6px; }
  textarea, input {
    width: 100%; border: 1.5px solid #dfe7e2; border-radius: 14px; padding: 12px 14px;
    font: 16px/1.4 system-ui, -apple-system, sans-serif; color: var(--text); background: #fff;
  }
  textarea { min-height: 120px; resize: vertical; }
  textarea:focus, input:focus { outline: none; border-color: var(--green); }
  .count { text-align: right; font-size: 0.78rem; color: var(--muted); margin-top: 4px; }
  button {
    height: 52px; border: none; border-radius: 14px; background: var(--green); color: #fff;
    font: 600 1rem system-ui, -apple-system, sans-serif; cursor: pointer; touch-action: manipulation;
  }
  button:disabled { opacity: 0.5; }
  button.secondary { background: var(--soft); color: var(--text); }
  .error { color: #b4441c; min-height: 1.2em; font-size: 0.9rem; }
  .done { text-align: center; padding: 30px 0 10px; }
  .done h2 { margin: 12px 0 6px; font-size: 1.3rem; }
  .check { display: inline-grid; grid-template-columns: repeat(5, 9px); gap: 2px; }
  .check i { width: 9px; height: 9px; }
  .check i.on { background: var(--green); }
  .small { font-size: 0.8rem; text-align: center; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <img class="logo" src="/pave-logo.png" alt="PAVE">
  ${
    valid
      ? `<section id="form-view">
    <h1><span class="mark"></span>Stel Ayla een vraag</h1>
    <p>Ayla is de AI-assistent van PAVE. Je vraag verschijnt op het grote scherm en Ayla beantwoordt hem hardop.</p>
  </section>
  <form id="form">
    <div>
      <label for="text">Je vraag</label>
      <textarea id="text" name="text" maxlength="${AUDIENCE_LIMITS.maxLength}" required placeholder="Bijvoorbeeld: hoe zorg je dat mijn gegevens veilig blijven?"></textarea>
      <div class="count"><span id="count">0</span>/${AUDIENCE_LIMITS.maxLength}</div>
    </div>
    <div>
      <label for="name">Je naam (mag je leeg laten)</label>
      <input id="name" name="name" maxlength="${AUDIENCE_LIMITS.maxNameLength}" autocomplete="given-name">
    </div>
    <p class="error" id="error" role="alert"></p>
    <button type="submit" id="send">Verstuur naar Ayla</button>
  </form>
  <section class="done" id="done" hidden>
    <div class="check" aria-hidden="true">${[
      '....#', '...##', '#.##.', '###..', '.#...'
    ]
      .map((row) => [...row].map((c) => `<i class="${c === '#' ? 'on' : ''}"></i>`).join(''))
      .join('')}</div>
    <h2>Verstuurd!</h2>
    <p>Je vraag staat klaar. Kijk naar het grote scherm.</p>
    <p style="margin-top:18px"><button class="secondary" id="again" type="button" style="width:100%">Nog een vraag stellen</button></p>
  </section>
  <p class="small">Stuur geen persoonsgegevens mee. Vragen worden alleen tijdens deze presentatie bewaard.</p>
<script>
  const form = document.getElementById('form'), text = document.getElementById('text'),
    count = document.getElementById('count'), error = document.getElementById('error'),
    send = document.getElementById('send'), done = document.getElementById('done');
  text.addEventListener('input', () => (count.textContent = text.value.length));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = ''; send.disabled = true;
    try {
      const res = await fetch('/api/audience/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ k: ${JSON.stringify(audience.token)}, text: text.value, name: document.getElementById('name').value })
      });
      if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data.statusMessage || 'Versturen lukte niet.'); }
      form.hidden = true; done.hidden = false; text.value = ''; count.textContent = '0';
    } catch (err) { error.textContent = err.message; }
    finally { send.disabled = false; }
  });
  document.getElementById('again').addEventListener('click', () => { done.hidden = true; form.hidden = false; text.focus(); });
</script>`
      : `<h1>Deze link werkt niet (meer)</h1><p>Scan de QR-code op het grote scherm opnieuw of typ de URL die erbij staat in je browser.</p>`
  }
</main>
</body>
</html>`
})
