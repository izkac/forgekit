export class ReconciliationService {
  #normalizers;
  #eventStore;
  #shipmentStore;

  constructor({ normalizers, eventStore, shipmentStore }) {
    this.#normalizers = normalizers;
    this.#eventStore = eventStore;
    this.#shipmentStore = shipmentStore;
  }

  async reconcile(carrier, payload) {
    const event = this.#normalizers.normalize(carrier, payload);
    const appendResult = await this.#eventStore.append(event);
    if (!appendResult.appended) {
      return { accepted: false, reason: "duplicate", event: appendResult.event };
    }
    const projection = await this.#shipmentStore.project(event);
    return { accepted: true, event, projection: projection.current };
  }
}

export const CarrierReconciliationService = ReconciliationService;
