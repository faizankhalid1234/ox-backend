const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

function clean(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function stripSlash(value) {
  return clean(value).replace(/\/$/, "");
}

const PORT = Number(process.env.PORT || 3000);

const config = {
  port: PORT,
  apiKey: clean(process.env.OXP_API_KEY),
  merchantId: clean(process.env.OXP_MERCHANT_ID),
  webhookPassword: clean(process.env.OXP_WEBHOOK_PASSWORD),
  paymentUrl: stripSlash(process.env.OXP_PAYMENT_URL),
  paymentCreateUrl: clean(process.env.OXP_PAYMENT_CREATE_URL),
  scanHost: clean(process.env.OXP_SCAN_HOST).toLowerCase(),
  publicAppUrl: stripSlash(process.env.PUBLIC_APP_URL || `http://localhost:${PORT}`),
  callbackUrl: stripSlash(process.env.CALLBACK_PUBLIC_URL),
  corsOrigin: clean(process.env.CORS_ORIGIN || "*"),
  dataDir: path.join(__dirname, "..", "data"),
  databaseUrl: clean(process.env.DATABASE_URL),
  useEmbeddedPostgres:
    String(process.env.USE_EMBEDDED_POSTGRES || "false").toLowerCase() === "true",
};

function credentialsReady() {
  return Boolean(
    config.merchantId &&
      config.paymentUrl &&
      config.paymentCreateUrl &&
      config.scanHost &&
      config.databaseUrl
  );
}

module.exports = {
  config,
  credentialsReady,
};
