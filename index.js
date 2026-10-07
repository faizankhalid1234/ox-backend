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
    dbReady = initDb();
  }
  return dbReady;
}

const corsOrigin =
  config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map((s) => s.trim());

app.use(cors({ origin: corsOrigin }));

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
  res.json({ ok: true, service: "ox-backend" });
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
        console.log(`ox-backend listening on :${config.port}`);
      });
    })
    .catch((error) => {
      console.error("DB init failed:", (error && error.message) || error);
      process.exit(1);
    });
}

module.exports = app;
