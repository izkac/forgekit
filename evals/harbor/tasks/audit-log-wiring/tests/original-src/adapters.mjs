export function createMemoryOrderStore() {
  let nextId = 1;
  const orders = [];
  return {
    orders,
    async save(input) {
      const order = { id: `order-${nextId}`, ...input };
      nextId += 1;
      orders.push(order);
      return order;
    }
  };
}

export function createMemoryAuditSink() {
  const entries = [];
  return {
    entries,
    async append(entry) {
      entries.push(entry);
    }
  };
}
