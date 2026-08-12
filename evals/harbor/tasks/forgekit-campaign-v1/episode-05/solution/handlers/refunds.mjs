import { OrderError } from "../orders.mjs";

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

export async function handleRefund({ request, response, store, id, sendJson, scope, readJson, requireOrder }) {
  const body = await readJson(request);
  const order = requireOrder(store, id);
  const refund = applyRefund(order, body.amountCents);
  sendJson(response, 200, refund, scope);
}
