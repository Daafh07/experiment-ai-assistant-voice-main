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
    // Optional public address for the audience QR code (for example a
    // tunnel). Without it the QR code uses this laptop's Wi-Fi address.
    publicUrl: process.env.PUBLIC_URL
  }
})
