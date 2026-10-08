# Ayla — de AI-assistent van PAVE

**Ayla** is de hoofdassistent van **PAVE** (Personal Achievement & Vision
Environment), het concept dat eerder "de Ontwikkelgids" heette. Ze helpt je
je kluis aan te vullen, je carrière of studiekeuze te verkennen, vacatures en
opleidingen te beoordelen, plannen te maken, aan je cv te werken en een
profiel op te stellen om te delen. Je kunt met haar typen of praten.

Ayla ondersteunt en neemt niet over: de gebruiker houdt de regie. Dat volgt
uit het concepttest-onderzoek (SURF/Npuls, mei 2026) en de feedback van
werkgevers.

In de app kies je een **voorbeeldkluis** (Ravi of Maria, de persona's uit het
schetsboek). Ayla kent dan die gegevens, zoals ze in de echte PAVE jouw kluis
zou kennen. Alles is voorbeelddata. Gebruik geen echte persoonsgegevens.

Technically: a Nuxt **voice** chatbot wired to an LLM through
[OpenRouter](https://openrouter.ai), plus browser-native speech in/out.

## Which OpenRouter models do you need?

Two different jobs, two different models — both set in `server/assistant.config.ts`:

- 🧠 **Deciding what to say** (text chat) — any text model, e.g. `mistralai/ministral-3b-2512`.
- 🔊 **Saying it out loud, in a human-sounding voice** — a model with
  **audio output**. On OpenRouter that currently means one of OpenAI's audio
  models:
  - `openai/gpt-audio` — higher quality, more expensive
  - `openai/gpt-audio-mini` — cheaper, used by default here

  Browse current audio-capable models at
  https://openrouter.ai/models?modality=text%2Baudio-%3Etext%2Baudio
  (model ids on OpenRouter occasionally change — if you get a
  `"... is not a valid model ID"` error, check that page for the current id).

  **These are not free-tier.** They cost noticeably more per request than a
  plain text model because they generate real audio. Make sure your
  OpenRouter account has credits: https://openrouter.ai/credits

- 🎤 **Microphone → text** still uses the browser's free, built-in
  `SpeechRecognition` API (Chrome/Edge only) — no OpenRouter model needed
  for this part, since OpenRouter doesn't do speech-to-text.

So the flow is: **mic → browser STT → text → OpenRouter text model →
text → OpenRouter audio model → spoken reply**. If the "Speak replies"
toggle is off, or the audio call fails, it falls back to the browser's
robotic built-in `speechSynthesis` voice so the demo never goes silent.

**Why it needs streaming:** OpenAI's audio-output models only return audio
when the request is streamed (`stream: true`), and only in raw `pcm16`
format while streaming — not `wav`/`mp3`. `server/api/chat.post.ts` reads
the streamed chunks, reassembles the raw PCM audio, and wraps it in a
minimal WAV header itself so the browser's `<audio>` element can play it
directly.

## Where to edit things

| What you want to change                  | File                               |
| ----------------------------------------- | ----------------------------------- |
| **Custom instructions** (system prompt)   | `server/assistant.config.ts`        |
| **Demo kluizen** (Ravi, Maria, …)         | `server/assistant.config.ts`        |
| **Which AI model is used**                | `server/assistant.config.ts`        |
| **API key**                               | `.env` (never commit this file!)    |
| **Chat UI / styling**                     | `app/app.vue`                       |
| **Server logic that calls OpenRouter**    | `server/api/chat.post.ts`           |

Everything needed to change Ayla's personality, her knowledge of PAVE or
the demo kluizen lives in `server/assistant.config.ts`.

## Setup

```bash
npm install
cp .env.example .env   # then paste your OpenRouter API key into .env
npm run dev
```

Open http://localhost:8000.

## Wachtwoord voor de privédemo

Stel `DEMO_PASSWORD` in `.env` in op een sterk, uniek wachtwoord. De browser
toont dan een inlogvenster: gebruik **ayla** als gebruikersnaam en het
ingestelde wachtwoord. De server controleert dit voor de demo, de
presentatorbediening en de AI-routes, inclusief chat en spraak. Alleen
`GET /vraag`, het logo en `POST /api/audience/ask` zijn openbaar: bezoekers
kunnen een vraag insturen zonder jouw demowachtwoord. Zij kunnen de
wachtrij niet lezen of afhandelen en kunnen geen AI-verzoeken starten.

Op Vercel voeg je `DEMO_PASSWORD` toe als environment variable voor elke
omgeving waarin je de demo deployt, en deploy je opnieuw. Gebruik online
altijd HTTPS. Een productiebuild zonder wachtwoord weigert toegang; alleen
de lokale ontwikkelserver mag zonder ingesteld wachtwoord draaien.

De browser onthoudt de login doorgaans tijdens de browsersessie. Gebruik
een privévenster voor de demo en sluit dat na afloop om de login te wissen.
Op Vercel gebruikt de publiekswachtrij gedeelde Supabase-opslag (of Redis
als alternatief).

## Privédemo deployen op Vercel

Deze configuratie ondersteunt de privédemo en publieksvragen via QR-code.
De presentator logt in; bezoekers openen alleen het openbare vragenformulier.

Koppel de repository aan een Vercel-project (of gebruik de Vercel CLI).
Kies **Nuxt** als framework, **Node.js 24.x**, `npm run build` als build
command en laat de output directory op de frameworkstandaard staan.
Gebruik geen `npm run generate`: de demo vereist serverroutes.

Voeg vóór het deployen de volgende environment variables toe in Vercel,
voor zowel Production als Preview als je beide gebruikt:

| Variabele | Waarde |
| --- | --- |
| `OPENROUTER_API_KEY` | Je OpenRouter API-key uit je lokale `.env` |
| `DEMO_PASSWORD` | Je sterke demowachtwoord uit je lokale `.env` |
| `SUPABASE_URL` | Project-URL, bijvoorbeeld `https://jouw-project.supabase.co` |
| `SUPABASE_SECRET_KEY` | Een geheime serverkey (`sb_secret_...`) uit je Supabase-project |
| `AUDIENCE_SESSION` | Een sessienaam, bijvoorbeeld `npuls-demo-1` (standaard: `demo`) |

Open in je bestaande Supabase-project de **SQL Editor** en voer deze
bestanden in volgorde uit:

1. `supabase/migrations/202610080001_audience.sql`: tabellen en serverfuncties.
2. `supabase/migrations/202610080002_audience_cleanup.sql`: automatische opruiming via Supabase Cron.

De scripts maken alleen Ayla-tabellen en -functies aan, zonder bestaande
projecttabellen te wijzigen. De gegevens staan in het afgeschermde schema
`ayla_private`, met RLS ingeschakeld en zonder toegang voor gewone gebruikers.
Alleen de server mag de drie RPC-functies uitvoeren. Laat `ayla_private`
buiten de exposed schemas van de Data API; de RPC-functies staan in `public`.

Kopieer je project-URL en een secret key uit Supabase naar de environment
variables in Vercel. De key blijft uitsluitend op de server; gebruik geen
`NUXT_PUBLIC_`-variabele. Een bestaande `SUPABASE_SERVICE_ROLE_KEY` wordt ook
ondersteund, maar een moderne `SUPABASE_SECRET_KEY` heeft de voorkeur. Gebruik
hier geen publishable/anon key: die mag de wachtrij niet lezen of wijzigen.
Deploy vervolgens opnieuw. Controleer onder Supabase Cron dat de job
`ayla-audience-cleanup` actief is en succesvol draait.

Supabase heeft voorrang als beide opslagdiensten zijn ingesteld. Redis blijft
als alternatief ondersteund met `UPSTASH_REDIS_REST_URL` en
`UPSTASH_REDIS_REST_TOKEN` (of `KV_REST_API_URL` en `KV_REST_API_TOKEN`).
De publieksfunctie weigert op Vercel toegang als gedeelde opslag ontbreekt,
zodat vragen niet ongemerkt in tijdelijke servergeheugens verdwijnen.

Upload of commit `.env` niet. Bij ontbrekend `DEMO_PASSWORD` blijft de
productiesite gesloten. Log na het deployen in met gebruikersnaam `ayla`.
De Vercel-functie gebruikt Node.js 24 en mag maximaal zestig seconden
draaien. Het Nitro-preset regelt de streaming van de spraakrespons.

Controleer na de deployment in een privévenster of de login verschijnt en
of typen, de microfoon en het voorlezen werken. Test de microfoon bij
voorkeur in Chrome of Edge. Een geslaagde lokale Vercel-build vervangt deze
controle van de daadwerkelijke deployment niet. Test ook de QR-code op een
telefoon zonder demo-login: stuur een vraag en behandel die met **V**.
Een eventuele Vercel Authentication-beveiliging voor de hele deployment
moet bezoekers toegang tot het formulier toestaan; de eigen app-login
beschermt de demo en de presentatorroutes.

## Supabase-koppeling controleren

Bij een fout toont de ingelogde presentator nu een specifieke melding. In
Vercel Logs staat daarnaast `Supabase RPC ...: HTTP ..., code ...`, zonder
keys of vraaginhoud. Deploy gewijzigde code en environment variables eerst
opnieuw voordat je de melding controleert.

Controleer in de SQL Editor van hetzelfde project als `SUPABASE_URL`:

```sql
select
  to_regprocedure('public.ayla_audience_state(text)') as wachtrij,
  to_regprocedure('public.ayla_audience_submit(text,text,text,text,text)') as insturen,
  to_regprocedure('public.ayla_audience_take(text,bigint)') as behandelen;
notify pgrst, 'reload schema';
```

Een key die begint met `sb_publishable_` is een publieke key en werkt niet
voor deze serverfuncties, ook niet als je hem `SUPABASE_SECRET_KEY` noemt.
Gebruik de geheime key (`sb_secret_...`) uit hetzelfde project, vervang de
waarde in je lokale `.env` en in Vercel en deploy opnieuw.

Een `NULL` betekent dat die functie ontbreekt: voer het eerste migratiescript
volledig uit. De `NOTIFY` vernieuwt de API-schema-cache. Bij HTTP 401
controleer je de geheime serverkey en of key en URL uit hetzelfde project
komen. Bij HTTP 403/`42501` controleer je de rechten uit het migratiescript.
Gebruik de project-URL (`https://...supabase.co`), geen Dashboard-URL. De
Data API moet ingeschakeld zijn met `public` als exposed schema; het private
schema `ayla_private` hoeft niet te worden exposed.

## Publieksvragen via QR-code of URL

Druk op **Q** om de QR-code te tonen. Wie niet kan scannen, kan de URL
onder de QR-code in de adresbalk van Safari of Chrome typen. Het korte
adres eindigt op `/vraag` en opent direct het vragenformulier, zonder code
in de URL.

Op Vercel gebruikt de QR-code automatisch het domein van de geopende site.
Met `PUBLIC_URL` kun je een eigen korte domeinnaam instellen. Openstaande
vragen verlopen vier uur na de laatste inzending; Supabase Cron verwijdert
ze vervolgens bij de eerstvolgende opruimronde (elke minuut). Een behandelde
of overgeslagen vraag wordt direct uit de wachtrij verwijderd. De globale
vraagnummer-sequence bevat geen vraagtekst en blijft behouden, zodat oude
vraag-ID's niet kunnen worden hergebruikt.
De sessiecode blijft gelijk bij een herstart of een nieuwe productiebuild.
Verander `AUDIENCE_SESSION` en deploy opnieuw om met een lege wachtrij te
beginnen. Oude sessies verlopen vanzelf. Preview-deployments hebben een
aparte wachtrij en mengen niet met Production.

Per telefoon kan één vraag per tien seconden worden ingestuurd. De
wachtrij bevat maximaal vijftig vragen; een aanvullend maximum van zestig
inzendingen per minuut per IP-adres beperkt misbruik. Alleen insturen
verbruikt geen AI-tegoed: Ayla antwoordt pas als de presentator **V** drukt.

Lokaal zonder Supabase of Redis gebruikt het adres het IP-adres van de laptop; telefoons
moeten dan op hetzelfde wifi-netwerk zitten. Voor een herkenbare korte URL
stel je `PUBLIC_URL` in `.env` in op een eigen domein of tunnel die naar
deze app verwijst. Alleen deze instelling maakt een domein nog niet
bereikbaar: het domein of de tunnel moet ook daadwerkelijk zijn ingericht.
Lokaal zonder gedeelde opslag vervallen QR-links met een oude sessiecode na een herstart.

`npm test` controleert de Supabase-migratie met een lokale, tijdelijke
PostgreSQL-database via PGlite. Dit test ook rollen en rechten, wachtrijlimieten
en verloop/opruiming; hiervoor zijn geen Supabase-accountgegevens nodig.

De Redis-integratietests kunnen zonder cloudaccount worden uitgevoerd met
`REDIS_SERVER_BIN=/pad/naar/redis-server npm test`; `redis-cli` moet ernaast
staan. Deze tests gebruiken een geïsoleerde tijdelijke database.

## How it works (for the class)

1. The browser sends the conversation to `POST /api/chat`.
2. That server route (`server/api/chat.post.ts`) runs on the server, not in
   the browser, so it can safely attach the API key as a header.
3. It prepends the custom system prompt from `assistant.config.ts` and
   forwards everything to OpenRouter's `chat/completions` endpoint.
4. OpenRouter routes the request to the chosen model and returns a reply,
   which is sent back to the browser and rendered as a chat bubble.

**Why the key lives on the server:** anything in browser-side JavaScript is
visible to any visitor. Routing the request through a Nuxt server route (the
`server/api/` folder) keeps the key out of the client bundle entirely.
