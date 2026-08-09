export function createOrderService({ orderStore, auditSink }) {
  return {
    async create(input) {
      const saved = await orderStore.save({
        sku: input.sku,
        quantity: input.quantity
      });
      await auditSink.append({
        action: "order.created",
        orderId: saved.id,
        sku: saved.sku
      });
      return saved;
    }
  };
}
