import http from "node:http";

const nowMs = process.env.NOW_MS === undefined ? Date.now() : Number(process.env.NOW_MS);
const port = Number(process.env.PORT ?? 3000);
const orders = [];
let nextId = 1;

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.status = 400;
    error.code = "invalid_json";
    throw error;
  }
}

function fail(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

function publicOrder(order) {
  return {
    id: order.id,
    customerId: order.customerId,
    items: order.items.slice(),
    status: order.status,
    totalCents: order.totalCents,
    chargedCents: order.chargedCents,
    refundedCents: order.refundedCents,
    createdAt: order.createdAt,
  };
}

function findOrder(id) {
  const order = orders.find((entry) => entry.id === id);
  if (!order) fail("not_found", "Order was not found", 404);
  return order;
}

function itemsTotal(items) {
  if (!Array.isArray(items) || items.length === 0) fail("invalid_items", "Order items must be a non-empty array", 400);
  let total = 0;
  for (const item of items) {
    if (typeof item?.sku !== "string" || item.sku.trim() === "") fail("invalid_items", "Each item needs a sku", 400);
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) fail("invalid_items", "Each item quantity must be a positive integer", 400);
    if (!Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
      fail("invalid_items", "Each item unitPriceCents must be a non-negative integer", 400);
    }
    total += item.quantity * item.unitPriceCents;
  }
  return total;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://orders.local");
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "POST" && parts.length === 1 && parts[0] === "orders") {
      const body = await readJson(request);
      if (typeof body.customerId !== "string" || body.customerId.trim() === "") {
        fail("invalid_customer", "customerId is required", 400);
      }
      const totalCents = itemsTotal(body.items);
      const order = {
        id: `order-${nextId}`,
        customerId: body.customerId,
        items: body.items.map((item) => ({ sku: item.sku, quantity: item.quantity, unitPriceCents: item.unitPriceCents })),
        status: "pending",
        totalCents,
        chargedCents: 0,
        refundedCents: 0,
        createdAt: nowMs,
      };
      nextId += 1;
      orders.push(order);
      sendJson(response, 201, publicOrder(order));
      return;
    }
    if (parts[0] !== "orders" || parts.length < 2) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const order = findOrder(decodeURIComponent(parts[1]));
    const action = parts[2];
    if (request.method === "GET" && parts.length === 2) {
      sendJson(response, 200, publicOrder(order));
      return;
    }
    if (request.method === "POST" && action === "charge" && parts.length === 3) {
      const body = await readJson(request);
      if (order.status === "cancelled") fail("cancelled_terminal", "Cancelled orders are terminal and move no money", 409);
      if (order.status !== "pending") fail("invalid_transition", "Only pending orders can be charged", 409);
      if (!Number.isSafeInteger(body.amountCents) || body.amountCents !== order.totalCents) {
        fail("invalid_amount", "Charge amountCents must equal the order total", 400);
      }
      order.chargedCents = body.amountCents;
      order.status = "paid";
      sendJson(response, 200, publicOrder(order));
      return;
    }
    if (request.method === "POST" && action === "ship" && parts.length === 3) {
      if (order.status !== "paid") fail("invalid_transition", "Only paid orders can be shipped", 409);
      order.status = "shipped";
      sendJson(response, 200, publicOrder(order));
      return;
    }
    if (request.method === "POST" && action === "deliver" && parts.length === 3) {
      if (order.status !== "shipped") fail("invalid_transition", "Only shipped orders can be delivered", 409);
      order.status = "delivered";
      sendJson(response, 200, publicOrder(order));
      return;
    }
    if (request.method === "POST" && action === "cancel" && parts.length === 3) {
      if (order.status !== "pending" && order.status !== "paid") {
        fail("invalid_transition", "Cannot cancel this order", 409);
      }
      order.status = "cancelled";
      sendJson(response, 200, publicOrder(order));
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    if (typeof error.status === "number") {
      sendJson(response, error.status, { error: error.code, message: error.message });
    } else {
      sendJson(response, 500, { error: "internal_error" });
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`listening on ${server.address().port}`);
});
