const { config, credentialsReady } = require("../lib/config");
const { createPayment, isScanPaymentUrl } = require("../lib/oxprocessing");
const db = require("../lib/db");

function sendError(res, error) {
  res.status(error.status || 500).json(error.body || { error: error.message });
}

function registerApiRoutes(app) {
  app.post("/api/payments/hosted", async (req, res) => {
    try {
      if (!credentialsReady()) {
        return res.status(500).json({
          error: "Server env is incomplete.",
          code: "missing_env",
        });
      }

      const body = req.body || {};
      const billingId = body.foreign_id || `order_${Date.now()}`;
      const clientId = body.end_user_reference || body.client_id || billingId;
      const email = body.end_user_email || body.email;
      const amount = body.amount;
      const currency = body.currency_iso || body.currency;

      if (!amount || !currency || !email) {
        return res.status(400).json({
          error: "Amount, currency, and email are required.",
        });
      }

      const isTest =
        body.test === true ||
        body.test === "true" ||
        body.Test === true ||
        body.Test === "true";

      const result = await createPayment({
        merchantId: config.merchantId,
        amount,
        currency,
        email,
        firstName: body.first_name || (body.sender_data && body.sender_data.first_name),
        lastName: body.last_name || (body.sender_data && body.sender_data.last_name),
        clientId,
        billingId,
        test: isTest,
      });

      if (
        result.body &&
        result.body.redirectUrl &&
        isScanPaymentUrl(result.body.redirectUrl)
      ) {
        const oxPaymentId =
          result.body.id !== undefined && result.body.id !== null
            ? String(result.body.id)
            : null;

        const saved = await db.insertPending({
          billing_id: result.billingId,
          payment_id: oxPaymentId,
          client_id: result.clientId,
          email,
          amount: String(amount),
          currency: result.currency,
          payment_link: result.body.redirectUrl,
        });

        return res.status(200).json({
          data: {
            id: result.billingId,
            status: "Pending",
            payment_link: result.body.redirectUrl,
            amount: String(amount),
            currency: { iso: result.currency },
            transaction: db.publicTransaction(saved),
          },
        });
      }

      res.status(result.status || 400).json(
        result.body || { error: "Scan payment URL could not be created." }
      );
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/transactions", async (_req, res) => {
    try {
      const rows = await db.listTransactions(30);
      res.json({ data: rows });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/transactions/:id", async (req, res) => {
    try {
      const result = await db.resolveStatus(req.params.id);

      if (!result.found) {
        return res.status(404).json({
          found: false,
          status: "Failed",
          error: "Transaction ID is not in the database.",
        });
      }

      res.json({
        found: true,
        status: result.display_status,
        approved: result.approved,
        data: db.publicTransaction(result.transaction),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/transactions/approve", async (req, res) => {
    try {
      const transactionId =
        (req.body && (req.body.transaction_id || req.body.id)) || "";

      if (!transactionId) {
        return res.status(400).json({
          found: false,
          status: "Failed",
          error: "transaction_id is required",
        });
      }

      const result = await db.resolveStatus(transactionId);

      if (!result.found) {
        return res.status(404).json({
          found: false,
          approved: false,
          status: "Failed",
          error: "Transaction ID is not in the database.",
        });
      }

      if (result.display_status === "Rejected") {
        return res.status(409).json({
          found: true,
          approved: false,
          status: "Rejected",
          data: db.publicTransaction(result.transaction),
          error: "Payment was rejected.",
        });
      }

      res.json({
        found: true,
        approved: true,
        status: "Approved",
        data: db.publicTransaction(result.transaction),
      });
    } catch (error) {
      sendError(res, error);
    }
  });
}

module.exports = {
  registerApiRoutes,
};
