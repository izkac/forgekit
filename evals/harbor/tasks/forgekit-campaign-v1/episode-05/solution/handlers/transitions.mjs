import { OrderError, publicOrder } from "../orders.mjs";

export async function handleCharge({ request, response, store, id, sendJson, scope, readJson, requireOrder, transition }) {
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
  sendJson(response, 200, publicOrder(order), scope);
}

export function handleShip({ response, store, id, sendJson, scope, requireOrder, transition }) {
  const order = requireOrder(store, id);
  transition(order, "shipped");
  sendJson(response, 200, publicOrder(order), scope);
}

export function handleDeliver({ response, store, id, sendJson, scope, requireOrder, transition }) {
  const order = requireOrder(store, id);
  transition(order, "delivered");
  sendJson(response, 200, publicOrder(order), scope);
}

export function handleCancel({ response, store, id, sendJson, scope, requireOrder, transition }) {
  const order = requireOrder(store, id);
  const chargedBefore = order.chargedCents;
  const refundedBefore = order.refundedCents;
  transition(order, "cancelled");
  order.chargedCents = chargedBefore;
  order.refundedCents = refundedBefore;
  sendJson(response, 200, publicOrder(order), scope);
}
