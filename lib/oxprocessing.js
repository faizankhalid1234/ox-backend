const crypto = require("crypto");

const PAYMENT_URL = "https://app.0xprocessing.com/Payment";
const PAYMENT_CREATE_URL = "https://app.0xprocessing.com/payment/create/";

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
  const key = raw.toUpperCase();
  return CURRENCY_ALIASES[key] || raw;
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
  return (
    value.includes("/create-payment") ||
    value.includes("/payment/create")
  );
}

function isScanPaymentUrl(url) {
  const value = String(url || "").toLowerCase();

  if (!value || isCreatePaymentUrl(value)) {
    return false;
  }

  // Current scan/QR page: https://pay.0xprocessing.com/payment/{uuid}
  if (/pay\.0xprocessing\.com\/payment\/[a-f0-9-]+/.test(value)) {
    return true;
  }

  // Legacy scan page: https://app.0xprocessing.com/Payment/Details/{id}
  if (value.includes("/payment/details/")) {
    return true;
  }

  return false;
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

    const location = toAbsoluteUrl(
      response.headers.get("location"),
      current
    );
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

async function createPaymentByPost({
  merchantId,
  amount,
  currency,
  email,
  firstName,
  lastName,
  clientId,
  billingId,
}) {
  const params = new URLSearchParams();
  params.set("MerchantId", merchantId);
  params.set("ClientId", clientId);
  params.set("BillingID", billingId);
  params.set("Email", email);
  params.set("Currency", currency);
  params.set("Amount", String(amount));
  params.set("FirstName", firstName || "Customer");
  params.set("LastName", lastName || "User");
  params.set("ReturnUrl", "true");
  params.set("Test", "true");

  const response = await fetch(PAYMENT_URL, {
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
  const location = toAbsoluteUrl(
    response.headers.get("location"),
    PAYMENT_URL
  );
  let scanUrl = extractScanUrl(body, location, PAYMENT_URL);

  // API may return pay.0xprocessing.com/payment/{id} as redirectUrl
  if (!scanUrl) {
    const candidate = toAbsoluteUrl(
      (body && (body.redirectUrl || body.RedirectUrl)) || location,
      PAYMENT_URL
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
        id: (body && (body.id || body.Id)) || billingId,
      },
      currency,
    };
  }

  if (location && isCreatePaymentUrl(location)) {
    const followed = await followToScanUrl(location);
    if (followed) {
      return {
        ok: true,
        status: response.status,
        body: { redirectUrl: followed, id: billingId },
        currency,
      };
    }
  }

  return {
    ok: false,
    status: response.status,
    body: body || {
      type: "IncorrectModel",
      message: "Scan payment URL was not returned.",
      raw: text ? String(text).slice(0, 500) : undefined,
    },
    currency,
  };
}

async function createPaymentByLink({
  merchantId,
  amount,
  currency,
  email,
  clientId,
  billingId,
}) {
  const qs = new URLSearchParams({
    MerchantId: merchantId,
    Currency: currency,
    Amount: String(amount),
    ClientID: clientId,
    BillingID: billingId,
    Email: email,
    Test: "true",
  });

  const startUrl = `${PAYMENT_CREATE_URL}?${qs.toString()}`;
  const scanUrl = await followToScanUrl(startUrl);

  if (scanUrl) {
    return {
      ok: true,
      status: 200,
      body: {
        redirectUrl: scanUrl,
        id: billingId,
      },
      currency,
    };
  }

  return {
    ok: false,
    status: 400,
    body: {
      type: "IncorrectModel",
      message: "Could not resolve scan payment URL from create link.",
    },
    currency,
  };
}

async function createPayment(options) {
  const currency = normalizeCurrency(options.currency);
  const clientId = cleanId(options.clientId, `c${Date.now()}`);
  const billingId = cleanId(options.billingId, `b${Date.now()}`);
  const payload = { ...options, currency, clientId, billingId };

  // Prefer POST: returns Payment/Details (QR/scan) URL, not create-payment form.
  let result = await createPaymentByPost(payload);

  if (!result.body || !isScanPaymentUrl(result.body.redirectUrl)) {
    result = await createPaymentByLink(payload);
  }

  if (result.body && result.body.redirectUrl && !isScanPaymentUrl(result.body.redirectUrl)) {
    return {
      ok: false,
      status: 502,
      body: {
        error: "Expected scan URL (Payment/Details), got create-payment link.",
        payment_link: result.body.redirectUrl,
      },
      billingId,
      clientId,
      currency,
    };
  }

  return {
    ...result,
    billingId,
    clientId,
  };
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
