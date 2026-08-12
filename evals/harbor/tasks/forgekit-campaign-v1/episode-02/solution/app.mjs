import http from "node:http";
import { OrderError, assertItems, canTransition, publicOrder, totalCentsFor } from "./orders.mjs";
import { MemoryOrderStore } from "./store.mjs";

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
    throw new OrderError("invalid_json", "Request body must be JSON", 400);
  }
}

function requireOrder(store, id) {
  const order = store.get(id);
  if (!order) throw new OrderError("not_found", "Order was not found", 404);
  return order;
}

function transition(order, next) {
  if (!canTransition(order.status, next)) {
    throw new OrderError("invalid_transition", `Cannot move from ${order.status} to ${next}`, 409);
  }
  order.status = next;
}

function applyRefund(order, amountCents) {
  if (order.status === "cancelled" || order.status === "pending") {
    throw new OrderError("invalid_refund", "Refunds are not allowed on pending or cancelled orders", 409);
  }
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new OrderError("invalid_amount", "Refund amountCents must be a positive integer", 400);
  }
  const remaining = order.chargedCents - order.refundedCents;
  if (amountCents > remaining) {
    throw new OrderError("refund_exceeds_remaining", "Refund exceeds the remaining charged balance", 409);
  }
  order.refundedCents += amountCents;
  order.refundCount = (order.refundCount || 0) + 1;
  return {
    id: `ref_${order.id}_${order.refundCount}`,
    orderId: order.id,
    amountCents,
  };
}

export function createApplication({ store = new MemoryOrderStore(), nowMs = () => Date.now() } = {}) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://orders.local");
      const parts = url.pathname.split("/").filter(Boolean);

      if (request.method === "POST" && parts.length === 1 && parts[0] === "orders") {
        const body = await readJson(request);
        if (typeof body.customerId !== "string" || body.customerId.trim() === "") {
          throw new OrderError("invalid_customer", "customerId is required", 400);
        }
        assertItems(body.items);
        const order = store.put({
          id: store.allocateId(),
          customerId: body.customerId,
          items: body.items.map((item) => ({
            sku: item.sku,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
          })),
          status: "pending",
          totalCents: totalCentsFor(body.items),
          chargedCents: 0,
          refundedCents: 0,
          createdAt: nowMs(),
        });
        sendJson(response, 201, publicOrder(order));
        return;
      }

      if (parts[0] !== "orders" || parts.length < 2) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const id = decodeURIComponent(parts[1]);
      const action = parts[2];

      if (request.method === "GET" && parts.length === 2) {
        sendJson(response, 200, publicOrder(requireOrder(store, id)));
        return;
      }

      if (request.method === "POST" && action === "charge" && parts.length === 3) {
        const body = await readJson(request);
        const order = requireOrder(store, id);
        if (order.status === "cancelled") {
          throw new OrderError("cancelled_terminal", "Cancelled orders are terminal and move no money", 409);
        }
        if (order.status !== "pending") {
          throw new OrderError("invalid_transition", "Only pending orders can be charged", 409);
        }
        if (!Number.isSafeInteger(body.amountCents) || body.amountCents !== order.totalCents) {
          throw new OrderError("invalid_amount", "Charge amountCents must equal the order total", 400);
        }
        order.chargedCents = body.amountCents;
        transition(order, "paid");
        sendJson(response, 200, publicOrder(order));
        return;
      }

      if (request.method === "POST" && action === "ship" && parts.length === 3) {
        const order = requireOrder(store, id);
        transition(order, "shipped");
        sendJson(response, 200, publicOrder(order));
        return;
      }

      if (request.method === "POST" && action === "deliver" && parts.length === 3) {
        const order = requireOrder(store, id);
        transition(order, "delivered");
        sendJson(response, 200, publicOrder(order));
        return;
      }

      if (request.method === "POST" && action === "cancel" && parts.length === 3) {
        const order = requireOrder(store, id);
        const chargedBefore = order.chargedCents;
        const refundedBefore = order.refundedCents;
        transition(order, "cancelled");
        order.chargedCents = chargedBefore;
        order.refundedCents = refundedBefore;
        sendJson(response, 200, publicOrder(order));
        return;
      }

      if (request.method === "POST" && action === "refunds" && parts.length === 3) {
        const body = await readJson(request);
        const order = requireOrder(store, id);
        const refund = applyRefund(order, body.amountCents);
        sendJson(response, 200, refund);
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof OrderError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
      } else {
        sendJson(response, 500, { error: "internal_error" });
      }
    }
  });
  return { server, store };
}
