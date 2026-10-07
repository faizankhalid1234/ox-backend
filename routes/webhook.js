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

  // Latest webhooks stored in DB (exact 0xProcessing JSON)
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

  console.log(
    "[0xProcessing webhook]",
    "Status=",
    payload.Status,
    "PaymentId=",
    payload.PaymentId,
    "BillingID=",
    payload.BillingID || payload.BillingId
  );

  if (!verifyWebhookSignature(payload, config.webhookPassword)) {
    console.error("[0xProcessing webhook] bad signature");
    return res.status(403).json({
      error: "Bad webhook signature",
      code: "bad_signature",
    });
  }

  try {
    await db.applyWebhook(payload);
  } catch (error) {
    console.error("[0xProcessing webhook] db error:", error.message);
    return res.status(500).json({ error: error.message });
  }

  // Forward EXACT 0xProcessing body to CALLBACK_PUBLIC_URL (webhook.cool)
  // so the viewer shows the same JSON OX sent.
  if (config.callbackUrl && !config.callbackUrl.includes("/webhooks/")) {
    forwardWebhook(config.callbackUrl, payload)
      .then(() => {
        console.log("[0xProcessing webhook] forwarded to", config.callbackUrl);
      })
      .catch((error) => {
        console.error(
          "[0xProcessing webhook] forward failed:",
          error && error.message
        );
      });
  }

  // OX requires HTTP 200 within ~3s
  res.status(200).end();
}

module.exports = {
  registerWebhookRoutes,
};
