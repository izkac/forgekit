import { OrderError, assertItems, publicOrder, totalCentsFor } from "../orders.mjs";

export async function handleCreate({ request, response, store, nowMs, sendJson, scope, readJson }) {
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
  sendJson(response, 201, publicOrder(order), scope);
}

export function handleGet({ response, store, id, sendJson, requireOrder }) {
  sendJson(response, 200, publicOrder(requireOrder(store, id)));
}
