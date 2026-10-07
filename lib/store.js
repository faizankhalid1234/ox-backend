const fs = require("fs");
const path = require("path");
const { config } = require("./config");

const storeFile = path.join(config.dataDir, "orders.json");

function emptyStore() {
  return {
    orders: {},
    callbacks: [],
  };
}

function ensureStore() {
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  if (!fs.existsSync(storeFile)) {
    fs.writeFileSync(storeFile, JSON.stringify(emptyStore(), null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(storeFile, "utf8"));
}

function writeStore(data) {
  ensureStore();
  fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
}

function upsertOrder(foreignId, patch) {
  const store = readStore();
  const current = store.orders[foreignId] || {
    foreign_id: foreignId,
    created_at: Date.now(),
  };

  store.orders[foreignId] = {
    ...current,
    ...patch,
    updated_at: Date.now(),
  };

  writeStore(store);
  return store.orders[foreignId];
}

function getOrder(foreignId) {
  return readStore().orders[foreignId] || null;
}

function findOrderByPaymentId(paymentRequestId) {
  return (
    Object.values(readStore().orders).find(
      (order) => order.payment_request_id === paymentRequestId
    ) || null
  );
}

function findOrderByAddressId(addressId) {
  return (
    Object.values(readStore().orders).find(
      (order) => String(order.address_id) === String(addressId)
    ) || null
  );
}

function findDepositByCustomer(customerId) {
  if (!customerId) {
    return null;
  }

  return (
    Object.values(readStore().orders).find(
      (order) => order.mode === "deposit" && order.customer_foreign_id === customerId
    ) || null
  );
}

function appendCallback(payload) {
  const store = readStore();
  store.callbacks.unshift({
    received_at: Date.now(),
    payload,
  });
  store.callbacks = store.callbacks.slice(0, 200);
  writeStore(store);
}

function listCallbacks(limit = 20) {
  return readStore().callbacks.slice(0, limit);
}

function redirectForStatus(status) {
  if (status === "paid" || status === "confirmed") {
    return "success";
  }

  if (status === "failed" || status === "expired" || status === "cancelled") {
    return "failed";
  }

  return null;
}

module.exports = {
  upsertOrder,
  getOrder,
  findOrderByPaymentId,
  findOrderByAddressId,
  findDepositByCustomer,
  appendCallback,
  listCallbacks,
  redirectForStatus,
};
