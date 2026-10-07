const crypto = require("crypto");
const { config } = require("./config");

const CURRENCY_ALIASES = {
  USDT: "USDT (TRC20)",
  UDT: "USDT (TRC20)",
  "UDT (TRC20)": "USDT (TRC20)",
  "USDT TRC20": "USDT (TRC20)",
  "USDT-TRC20": "USDT (TRC20)",
  "USDT ERC20": "USDT (ERC20)",
  "USDT-ERC20": "USDT (ERC20)",
  USDC: "USDC (ERC20)",
  "USDC ERC20": "USDC (ERC20)",
};

function normalizeCurrency(value) {
  const raw = String(value || "").trim();
  return CURRENCY_ALIASES[raw.toUpperCase()] || raw;
}

function cleanId(value, fallback) {
  const compact = String(value || "").replace(/[^a-zA-Z0-9]/g, "");
  return compact.slice(0, 100) || fallback;
}

function md5(value) {
  return crypto.createHash("md5").update(value, "utf8").digest("hex");
}

function parseBody(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

function isCreatePaymentUrl(url) {
  const value = String(url || "").toLowerCase();
  return value.includes("/create-payment") || value.includes("/payment/create");
}

function isScanPaymentUrl(url) {
  const value = String(url || "").toLowerCase();
  if (!value || isCreatePaymentUrl(value)) {
    return false;
  }

  const host = config.scanHost;
  if (host) {
    const escaped = host.replace(/\./g, "\\.");
    const pattern = new RegExp(`${escaped}/payment/[a-f0-9-]+`);
    if (pattern.test(value)) {
      return true;
    }
  }

  return value.includes("/payment/details/");
}

function toAbsoluteUrl(url, base) {
  if (!url) {
    return null;
  }
  if (String(url).startsWith("http")) {
    return String(url);
  }
  return new URL(String(url), base).toString();
}

function extractScanUrl(body, location, base) {
  const candidates = [
    body && body.redirectUrl,
    body && body.RedirectUrl,
    body && body.paymentUrl,
    location,
  ];

  for (const candidate of candidates) {
    const absolute = toAbsoluteUrl(candidate, base);
    if (absolute && isScanPaymentUrl(absolute)) {
      return absolute;
    }
  }

  return null;
}

function verifyWebhookSignature(payload, webhookPassword) {
  const paymentId = payload.PaymentId;
  const merchantId = payload.MerchantId || payload.ShopId;
  const email = payload.Email;
  const currency = payload.Currency;
  const signature = String(payload.Signature || "").toLowerCase();

  if (
    paymentId === undefined ||
    paymentId === null ||
    !merchantId ||
    !email ||
    !currency ||
    !webhookPassword ||
    !signature
  ) {
    return false;
  }

  const expected = md5(
    `${paymentId}:${merchantId}:${email}:${currency}:${webhookPassword}`
  );
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(signature, "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

async function followToScanUrl(startUrl) {
  let current = startUrl;

  for (let i = 0; i < 5; i += 1) {
    if (isScanPaymentUrl(current)) {
      return current;
    }

    if (!isCreatePaymentUrl(current) && i > 0) {
      break;
    }

    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/json,text/html" },
    });

    const location = toAbsoluteUrl(response.headers.get("location"), current);
    const body = parseBody(await response.text());
    const scan = extractScanUrl(body, location, current);

    if (scan) {
      return scan;
    }

    if (location) {
      current = location;
      continue;
    }

    break;
  }

  return null;
}

async function createPaymentByPost(options) {
  const paymentUrl = config.paymentUrl;
  const params = new URLSearchParams();
  params.set("MerchantId", options.merchantId);
  params.set("ClientId", options.clientId);
  params.set("BillingID", options.billingId);
  params.set("Email", options.email);
  params.set("Currency", options.currency);
  params.set("Amount", String(options.amount));
  params.set("FirstName", options.firstName || "Customer");
  params.set("LastName", options.lastName || "User");
  params.set("ReturnUrl", "true");
  if (options.test) {
    params.set("Test", "true");
  }

  const response = await fetch(paymentUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    redirect: "manual",
  });

  const text = await response.text();
  const body = parseBody(text);
  const location = toAbsoluteUrl(response.headers.get("location"), paymentUrl);
  let scanUrl = extractScanUrl(body, location, paymentUrl);

  if (!scanUrl) {
    const candidate = toAbsoluteUrl(
      (body && (body.redirectUrl || body.RedirectUrl)) || location,
      paymentUrl
    );
    if (candidate && isScanPaymentUrl(candidate)) {
      scanUrl = candidate;
    }
  }

  if (scanUrl) {
    return {
      ok: true,
      status: response.status,
      body: {
        redirectUrl: scanUrl,
        id: (body && (body.id || body.Id)) || options.billingId,
      },
      currency: options.currency,
    };
  }

  if (location && isCreatePaymentUrl(location)) {
    const followed = await followToScanUrl(location);
    if (followed) {
      return {
        ok: true,
        status: response.status,
        body: { redirectUrl: followed, id: options.billingId },
        currency: options.currency,
      };
    }
  }

  return {
    ok: false,
    status: response.status,
    body: body || {
      type: "IncorrectModel",
      message: "Scan payment URL was not returned.",
    },
    currency: options.currency,
  };
}

async function createPaymentByLink(options) {
  const qs = new URLSearchParams({
    MerchantId: options.merchantId,
    Currency: options.currency,
    Amount: String(options.amount),
    ClientID: options.clientId,
    BillingID: options.billingId,
    Email: options.email,
  });

  if (options.test) {
    qs.set("Test", "true");
  }

  const startUrl = `${config.paymentCreateUrl}?${qs.toString()}`;
  const scanUrl = await followToScanUrl(startUrl);

  if (scanUrl) {
    return {
      ok: true,
      status: 200,
      body: { redirectUrl: scanUrl, id: options.billingId },
      currency: options.currency,
    };
  }

  return {
    ok: false,
    status: 400,
    body: {
      type: "IncorrectModel",
      message: "Could not resolve scan payment URL from create link.",
    },
    currency: options.currency,
  };
}

async function createPayment(options) {
  const currency = normalizeCurrency(options.currency);
  const clientId = cleanId(options.clientId, `c${Date.now()}`);
  const billingId = cleanId(options.billingId, `b${Date.now()}`);
  const payload = { ...options, currency, clientId, billingId };

  let result = await createPaymentByPost(payload);

  if (!result.body || !isScanPaymentUrl(result.body.redirectUrl)) {
    result = await createPaymentByLink(payload);
  }

  if (
    result.body &&
    result.body.redirectUrl &&
    !isScanPaymentUrl(result.body.redirectUrl)
  ) {
    return {
      ok: false,
      status: 502,
      body: { error: "Expected scan payment URL." },
      billingId,
      clientId,
      currency,
    };
  }

  return { ...result, billingId, clientId };
}

async function forwardWebhook(url, payload) {
  if (!url || url.includes("/webhooks/")) {
    return;
  }

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

module.exports = {
  md5,
  normalizeCurrency,
  isScanPaymentUrl,
  verifyWebhookSignature,
  createPayment,
  forwardWebhook,
};
