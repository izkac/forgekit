export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function expireIfStale(order, nowMs) {
  if (!order) return order;
  if (order.status !== "pending") return order;
  if (nowMs - order.createdAt < THIRTY_DAYS_MS) return order;
  order.status = "expired";
  return order;
}
