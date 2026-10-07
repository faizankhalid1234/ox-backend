# ox-backend

0xProcessing payment API, PostgreSQL (Neon), and webhooks.

## Setup

1. Copy `.env.example` → `.env` and fill values.
2. `npm install`
3. `npm start` → http://localhost:3000

## Vercel

Set env vars: `DATABASE_URL`, `USE_EMBEDDED_POSTGRES=false`, `OXP_API_KEY`, `OXP_MERCHANT_ID`, `OXP_WEBHOOK_PASSWORD`, `PUBLIC_APP_URL`, `CALLBACK_PUBLIC_URL`.

Webhook URL for 0xProcessing portal:

```text
https://YOUR-BACKEND.vercel.app/webhooks/0xprocessing
```
