const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

function clean(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

const PORT = Number(process.env.PORT || 3000);

const config = {
  port: PORT,
  apiKey: clean(process.env.OXP_API_KEY),
  merchantId: clean(process.env.OXP_MERCHANT_ID),
  webhookPassword: clean(process.env.OXP_WEBHOOK_PASSWORD),
  paymentUrl: "https://app.0xprocessing.com/Payment",
  publicAppUrl: (process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`).replace(
    /\/$/,
    ""
  ),
  callbackUrl:
    process.env.CALLBACK_PUBLIC_URL ||
    `${(process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "")}/webhooks/0xprocessing`,
  dataDir: path.join(__dirname, "..", "data"),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://ox:ox@localhost:5432/oxprocessing",
  // Neon / remote: keep false. Only true for local embedded Postgres.
  useEmbeddedPostgres:
    String(process.env.USE_EMBEDDED_POSTGRES || "false").toLowerCase() ===
    "true",
};

function credentialsReady() {
  return Boolean(config.merchantId);
}

module.exports = {
  config,
  credentialsReady,
};
