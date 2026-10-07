const express = require("express");
const cors = require("cors");
const { config } = require("./lib/config");
const { initDb } = require("./lib/db");
const { registerApiRoutes } = require("./routes/api");
const { registerWebhookRoutes } = require("./routes/webhook");

const app = express();
let dbReady = null;

function ensureDb() {
  if (!dbReady) {
    dbReady = initDb().then(() => {
      console.log("PostgreSQL ready");
    });
  }
  return dbReady;
}

app.use(cors({ origin: true }));
app.use(async (_req, _res, next) => {
  try {
    await ensureDb();
    next();
  } catch (error) {
    next(error);
  }
});
app.use(
  ["/webhooks/cryptoprocessing", "/webhooks/0xprocessing"],
  express.raw({ type: "*/*", limit: "2mb" })
);
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "ox-backend",
    webhook: "/webhooks/0xprocessing",
  });
});

registerApiRoutes(app);
registerWebhookRoutes(app);

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: (err && err.message) || "Server error" });
});

if (!process.env.VERCEL) {
  ensureDb()
    .then(() => {
      app.listen(config.port, () => {
        const receiveUrl = `${config.publicAppUrl}/webhooks/0xprocessing`;
        console.log(`Backend running at ${config.publicAppUrl}`);
        console.log(`Webhook RECEIVE: ${receiveUrl}`);
        console.log(`Webhook FORWARD: ${config.callbackUrl}`);
      });
    })
    .catch((error) => {
      console.error(
        "PostgreSQL connection failed:",
        (error && error.message) || error
      );
      process.exit(1);
    });
}

module.exports = app;
