export class MemoryOrderStore {
  constructor() {
    this.orders = new Map();
    this.nextId = 1;
  }

  allocateId() {
    const id = `ord_${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  put(order) {
    this.orders.set(order.id, order);
    return order;
  }

  get(id) {
    return this.orders.get(id);
  }
}
