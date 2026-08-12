export class OrderError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "OrderError";
    this.code = code;
    this.status = status;
  }
}

const ALLOWED_TRANSITIONS = {
  pending: new Set(["paid", "cancelled"]),
  paid: new Set(["shipped", "cancelled"]),
  shipped: new Set(["delivered"]),
  delivered: new Set(),
  cancelled: new Set(),
};

export function totalCentsFor(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
}

export function assertItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new OrderError("invalid_items", "Order items must be a non-empty array", 400);
  }
  for (const item of items) {
    if (typeof item?.sku !== "string" || item.sku.trim() === "") {
      throw new OrderError("invalid_items", "Each item needs a sku", 400);
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new OrderError("invalid_items", "Each item quantity must be a positive integer", 400);
    }
    if (!Number.isSafeInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
      throw new OrderError("invalid_items", "Each item unitPriceCents must be a non-negative integer", 400);
    }
  }
}

export function canTransition(from, to) {
  return ALLOWED_TRANSITIONS[from]?.has(to) === true;
}

export function publicOrder(order) {
  return {
    id: order.id,
    customerId: order.customerId,
    items: order.items.map((item) => ({ ...item })),
    status: order.status,
    totalCents: order.totalCents,
    chargedCents: order.chargedCents,
    refundedCents: order.refundedCents,
    createdAt: order.createdAt,
  };
}
