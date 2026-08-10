export class ShipmentProjectionStore {
  #shipments = new Map();

  project(event) {
    const previous = this.#shipments.get(event.shipmentId);
    const projection = {
      shipmentId: event.shipmentId,
      carrier: event.carrier,
      status: event.status,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      eventId: event.eventId,
    };
    this.#shipments.set(event.shipmentId, projection);
    return { previous: previous ? { ...previous } : undefined, current: { ...projection } };
  }

  get(shipmentId) {
    const projection = this.#shipments.get(shipmentId);
    return projection ? { ...projection } : undefined;
  }

  entries() {
    return [...this.#shipments.values()].map((projection) => ({ ...projection }));
  }
}

export const InMemoryShipmentStore = ShipmentProjectionStore;
