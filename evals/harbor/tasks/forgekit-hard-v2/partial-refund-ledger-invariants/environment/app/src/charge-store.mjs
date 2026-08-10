export class MemoryChargeStore {
  #charges;

  constructor(charges = []) {
    this.#charges = new Map(charges.map((charge) => [charge.id, { ...charge }]));
  }

  get(id) {
    const charge = this.#charges.get(id);
    return charge ? { ...charge } : undefined;
  }
}
