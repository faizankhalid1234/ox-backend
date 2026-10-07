const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const { config } = require("./config");

let pool = null;
let embedded = null;

async function startEmbeddedPostgres() {
  // Lazy ESM import — never load on Vercel / Neon (avoids ERR_REQUIRE_ESM)
  const mod = await import("embedded-postgres");
  const EmbeddedPostgres = mod.default;

  const databaseDir = path.join(config.dataDir, "pg");
  fs.mkdirSync(databaseDir, { recursive: true });

  embedded = new EmbeddedPostgres({
    databaseDir,
    user: "ox",
    password: "ox",
    port: 55432,
    persistent: true,
  });

  const marker = path.join(databaseDir, "PG_VERSION");
  if (!fs.existsSync(marker)) {
    await embedded.initialise();
  }

  await embedded.start();

  try {
    await embedded.createDatabase("oxprocessing");
  } catch {
    // Database already exists on subsequent starts.
  }

  return "postgres://ox:ox@127.0.0.1:55432/oxprocessing";
}

function poolOptions(connectionString) {
  const needsSsl =
    /neon\.tech|sslmode=require|ssl=true/i.test(connectionString) ||
    process.env.NODE_ENV === "production";

  return {
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  };
}

async function initDb() {
  let connectionString = config.databaseUrl;

  if (config.useEmbeddedPostgres) {
    connectionString = await startEmbeddedPostgres();
  }

  pool = new Pool(poolOptions(connectionString));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      billing_id TEXT UNIQUE NOT NULL,
      payment_id TEXT UNIQUE,
      client_id TEXT,
      email TEXT,
      amount TEXT,
      currency TEXT,
      payment_link TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hashes TEXT[] NOT NULL DEFAULT '{}',
      last_webhook JSONB,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_transactions_payment_id
    ON transactions (payment_id)
  `);
}

async function insertPending(row) {
  const result = await pool.query(
    `
    INSERT INTO transactions (
      billing_id, payment_id, client_id, email, amount, currency, payment_link, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
    ON CONFLICT (billing_id) DO UPDATE SET
      payment_id = COALESCE(EXCLUDED.payment_id, transactions.payment_id),
      client_id = EXCLUDED.client_id,
      email = EXCLUDED.email,
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      payment_link = EXCLUDED.payment_link,
      status = CASE
        WHEN transactions.status IN ('success', 'paid', 'failed') THEN transactions.status
        ELSE 'pending'
      END,
      updated_at = NOW()
    RETURNING *
    `,
    [
      row.billing_id,
      row.payment_id || null,
      row.client_id || null,
      row.email || null,
      row.amount || null,
      row.currency || null,
      row.payment_link || null,
    ]
  );

  return result.rows[0];
}

async function findByAnyId(transactionId) {
  const id = String(transactionId || "").trim();

  if (!id) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT *
    FROM transactions
    WHERE billing_id = $1
       OR payment_id = $1
       OR client_id = $1
       OR $1 = ANY(tx_hashes)
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

function mapWebhookStatus(payload) {
  const statusRaw = String(payload.Status || "").toLowerCase();
  const insufficient = Boolean(payload.Insufficient);

  if (statusRaw === "success" && !insufficient) {
    return "success";
  }

  if (
    statusRaw === "canceled" ||
    statusRaw === "cancelled" ||
    statusRaw === "insufficient" ||
    (statusRaw === "success" && insufficient)
  ) {
    return "failed";
  }

  return "pending";
}

function displayStatus(dbStatus) {
  if (dbStatus === "success" || dbStatus === "paid" || dbStatus === "approved") {
    return "Success";
  }

  if (dbStatus === "failed") {
    return "Failed";
  }

  return "Pending";
}

async function applyWebhook(payload) {
  const billingRaw = String(payload.BillingID || payload.BillingId || "").trim();
  const billingClean = billingRaw.replace(/[^a-zA-Z0-9]/g, "");
  const clientRaw = String(payload.ClientId || payload.ClientID || "").trim();
  const clientClean = clientRaw.replace(/[^a-zA-Z0-9]/g, "");
  const paymentId =
    payload.PaymentId === undefined || payload.PaymentId === null
      ? null
      : String(payload.PaymentId);
  const hashes = Array.isArray(payload.TxHashes)
    ? payload.TxHashes.map(String)
    : [];
  const status = mapWebhookStatus(payload);
  const approvedAt = status === "success" ? new Date().toISOString() : null;

  const updated = await pool.query(
    `
    UPDATE transactions SET
      payment_id = COALESCE($1::text, payment_id),
      status = $2::text,
      email = COALESCE($3::text, email),
      amount = COALESCE($4::text, amount),
      currency = COALESCE($5::text, currency),
      client_id = COALESCE(NULLIF($6::text, ''), client_id),
      tx_hashes = CASE
        WHEN $7::text[] = '{}' THEN tx_hashes
        ELSE $7::text[]
      END,
      last_webhook = $8::jsonb,
      approved_at = CASE
        WHEN $2::text = 'success' THEN COALESCE(approved_at, NOW())
        ELSE approved_at
      END,
      updated_at = NOW()
    WHERE (
        ($9::text <> '' AND (billing_id = $9::text OR billing_id = $10::text))
        OR ($1::text IS NOT NULL AND payment_id = $1::text)
      )
    RETURNING *
    `,
    [
      paymentId,
      status,
      payload.Email || null,
      payload.Amount != null ? String(payload.Amount) : null,
      payload.Currency || null,
      clientClean || clientRaw || "",
      hashes,
      JSON.stringify(payload),
      billingRaw,
      billingClean,
    ]
  );

  if (updated.rows[0]) {
    return updated.rows[0];
  }

  if (!paymentId && !billingRaw && !billingClean) {
    return null;
  }

  const inserted = await pool.query(
    `
    INSERT INTO transactions (
      billing_id, payment_id, client_id, email, amount, currency,
      status, tx_hashes, last_webhook, approved_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
    ON CONFLICT (billing_id) DO UPDATE SET
      payment_id = COALESCE(EXCLUDED.payment_id, transactions.payment_id),
      status = EXCLUDED.status,
      last_webhook = EXCLUDED.last_webhook,
      tx_hashes = CASE
        WHEN EXCLUDED.tx_hashes = '{}' THEN transactions.tx_hashes
        ELSE EXCLUDED.tx_hashes
      END,
      approved_at = CASE
        WHEN EXCLUDED.status = 'success' THEN COALESCE(transactions.approved_at, NOW())
        ELSE transactions.approved_at
      END,
      updated_at = NOW()
    RETURNING *
    `,
    [
      billingClean || billingRaw || `pay${paymentId}`,
      paymentId,
      clientClean || clientRaw || null,
      payload.Email || null,
      payload.Amount != null ? String(payload.Amount) : null,
      payload.Currency || null,
      status,
      hashes,
      JSON.stringify(payload),
      approvedAt,
    ]
  );

  return inserted.rows[0];
}

async function resolveStatus(transactionId) {
  const row = await findByAnyId(transactionId);

  if (!row) {
    return {
      found: false,
      display_status: "Failed",
      approved: false,
      transaction: null,
    };
  }

  const shown = displayStatus(row.status);

  return {
    found: true,
    display_status: shown,
    approved: shown === "Success",
    transaction: row,
  };
}

async function listTransactions(limit = 20) {
  const result = await pool.query(
    `
    SELECT *
    FROM transactions
    ORDER BY updated_at DESC
    LIMIT $1
    `,
    [limit]
  );

  return result.rows.map((row) => {
    const publicRow = publicTransaction(row);
    return {
      ...publicRow,
      display_status: displayStatus(row.status),
    };
  });
}

function publicTransaction(row) {
  if (!row) {
    return null;
  }

  return {
    billing_id: row.billing_id,
    payment_id: row.payment_id,
    client_id: row.client_id,
    email: row.email,
    amount: row.amount,
    currency: row.currency,
    status: displayStatus(row.status),
    payment_status: displayStatus(row.status),
    tx_hashes: row.tx_hashes,
    approved_at: row.approved_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_webhook: row.last_webhook || null,
  };
}

async function listRecentWebhooks(limit = 20) {
  const result = await pool.query(
    `
    SELECT billing_id, payment_id, status, last_webhook, updated_at
    FROM transactions
    WHERE last_webhook IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT $1
    `,
    [limit]
  );

  return result.rows.map((row) => ({
    billing_id: row.billing_id,
    payment_id: row.payment_id,
    database_status: displayStatus(row.status),
    received_at: row.updated_at,
    // Exact payload from 0xProcessing
    webhook: row.last_webhook,
  }));
}

module.exports = {
  initDb,
  insertPending,
  findByAnyId,
  applyWebhook,
  approveIfExists: resolveStatus,
  resolveStatus,
  listTransactions,
  listRecentWebhooks,
  publicTransaction,
};
