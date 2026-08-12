import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export class FileOrderStore {
  constructor(file = path.join("data", "orders.json")) {
    this.file = file;
    this.orders = new Map();
    this.nextId = 1;
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      this.nextId = parsed.nextId;
      this.orders = new Map();
      for (const order of parsed.orders) this.orders.set(order.id, order);
    } catch {
      this.orders = new Map();
      this.nextId = 1;
    }
  }

  save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = `${JSON.stringify({
      nextId: this.nextId,
      orders: [...this.orders.values()],
    })}\n`;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, payload);
    renameSync(tmp, this.file);
  }

  allocateId() {
    const id = `ord_${this.nextId}`;
    this.nextId += 1;
    this.save();
    return id;
  }

  put(order) {
    this.orders.set(order.id, order);
    this.save();
    return order;
  }

  get(id) {
    return this.orders.get(id);
  }
}
