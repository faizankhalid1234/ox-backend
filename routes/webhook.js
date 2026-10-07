const { config } = require("../lib/config");
const { verifyWebhookSignature, forwardWebhook } = require("../lib/oxprocessing");
const db = require("../lib/db");

function rawBodyToString(body) {
  if (Buffer.isBuffer(body)) {
    return body.toString("utf8");
  }
  if (typeof body === "string") {
    return body;
  }
  return JSON.stringify(body || {});
}

function registerWebhookRoutes(app) {
  app.post("/webhooks/0xprocessing", handleWebhook);
  app.post("/webhooks/cryptoprocessing", handleWebhook);

  app.get("/api/webhooks/latest", async (_req, res) => {
    try {
      const rows = await db.listRecentWebhooks(30);
      res.json({ data: rows });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

async function handleWebhook(req, res) {
  const rawBody = rawBodyToString(req.body);
  let payload;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({
      error: "Bad content format",
      code: "bad_content_format",
    });
  }

  if (!verifyWebhookSignature(payload, config.webhookPassword)) {
    return res.status(403).json({
      error: "Bad webhook signature",
      code: "bad_signature",
    });
  }

  try {
    await db.applyWebhook(payload);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  if (config.callbackUrl && !config.callbackUrl.includes("/webhooks/")) {
    forwardWebhook(config.callbackUrl, payload).catch(() => {});
  }

  res.status(200).end();
}

module.exports = {
  registerWebhookRoutes,
};
