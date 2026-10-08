import process from 'node:process'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  devServer: { port: 8000, host: '0.0.0.0' },

  nitro: {
    vercel: {
      functions: {
        runtime: 'nodejs24.x',
        // Leave room for the AI request and streamed speech response.
        maxDuration: 60
      }
    }
  },

  // The API key is read from the .env file and only ever used on the
  // server (in server/api/chat.post.ts). It is never sent to the browser.
  runtimeConfig: {
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    // Server-only password for the private demo (username: ayla).
    demoPassword: process.env.DEMO_PASSWORD || '',
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    audienceRedisUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '',
    audienceRedisToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '',
    audienceSession: process.env.AUDIENCE_SESSION || 'demo',
    audienceHosted: Boolean(process.env.VERCEL || process.env.NITRO_PRESET?.startsWith('vercel')),
    // Optional domain/tunnel override. Hosted QR codes use the site origin;
    // local ones use this laptop's Wi-Fi address.
    publicUrl: process.env.PUBLIC_URL
  }
})
