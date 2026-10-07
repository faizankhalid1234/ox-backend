const crypto = require("crypto");

function compactJson(value) {
  return JSON.stringify(value ?? {});
}

function signBody(secretKey, bodyString) {
  return crypto.createHmac("sha512", secretKey).update(bodyString).digest("hex");
}

function verifyCallbackSignature(secretKey, rawBody, headerSignature) {
  if (!headerSignature || !rawBody) {
    return false;
  }

  const expected = signBody(secretKey, rawBody);
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(String(headerSignature).trim(), "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

async function requestProcessing({ apiBase, apiKey, secretKey, method, path, payload }) {
  const url = `${apiBase}${path}`;
  const isGet = method.toUpperCase() === "GET";
  const bodyString = isGet ? "" : compactJson(payload ?? {});
  const headers = {
    Accept: "application/json",
  };

  if (!isGet) {
    headers["Content-Type"] = "application/json";
    headers["X-Processing-Key"] = apiKey;
    headers["X-Processing-Signature"] = signBody(secretKey, bodyString);
  }

  const response = await fetch(url, {
    method,
    headers,
    body: isGet ? undefined : bodyString,
  });

  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

module.exports = {
  compactJson,
  signBody,
  verifyCallbackSignature,
  requestProcessing,
};
