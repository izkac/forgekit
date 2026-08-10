export class ReconciliationService {
  constructor({ normalizers, eventStore, shipmentStore }) {
    this.normalizers = normalizers;
    this.eventStore = eventStore;
    this.shipmentStore = shipmentStore;
    this.seenIds = new Set();
  }

  async reconcile(carrier, payload) {
    const event = this.normalizers.normalize(carrier, payload);
    if (this.seenIds.has(event.eventId)) {
      return { accepted: false, reason: "duplicate", event };
    }
    const result = await this.eventStore.append(event);
    if (!result.appended) return { accepted: false, reason: "duplicate", event: result.event };
    this.seenIds.add(event.eventId);
    const projection = await this.shipmentStore.project(event);
    return { accepted: true, event, projection: projection.current };
  }
}

export const CarrierReconciliationService = ReconciliationService;
