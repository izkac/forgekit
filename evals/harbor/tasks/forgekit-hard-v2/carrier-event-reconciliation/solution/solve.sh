#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-/app}
cat > "$app_dir/src/reconciliation-service.mjs" <<'EOF_SERVICE'
import { CarrierEventError } from "./errors.mjs";

function isLater(event, current) {
  if (!current || current.status === "delivered") return !current;
  if (event.sequence !== current.sequence) return event.sequence > current.sequence;
  return event.occurredAt > current.occurredAt;
}

export class ReconciliationService {
  #normalizers;
  #eventStore;
  #shipmentStore;
  #seen = new Set();

  constructor({ normalizers, eventStore, shipmentStore }) {
    this.#normalizers = normalizers;
    this.#eventStore = eventStore;
    this.#shipmentStore = shipmentStore;
  }

  async reconcile(carrier, payload) {
    const event = this.#normalizers.normalize(carrier, payload);
    const key = `${event.carrier}\u0000${event.eventId}`;
    if (this.#seen.has(key)) {
      return { accepted: false, reason: "duplicate", event };
    }
    const appendResult = await this.#eventStore.append(event);
    if (!appendResult.appended) {
      this.#seen.add(key);
      return { accepted: false, reason: "duplicate", event: appendResult.event };
    }
    this.#seen.add(key);
    const current = this.#shipmentStore.get(event.shipmentId);
    if (isLater(event, current)) {
      const projection = await this.#shipmentStore.project(event);
      return { accepted: true, event, projection: projection.current };
    }
    return { accepted: true, event, projection: current };
  }
}

export const CarrierReconciliationService = ReconciliationService;
EOF_SERVICE
cat > "$app_dir/src/event-store.mjs" <<'EOF_STORE'
export class AppendOnlyEventStore {
  #events = [];
  #eventKeys = new Set();

  append(event) {
    const key = `${event.carrier}\u0000${event.eventId}`;
    const existing = this.#events.find((entry) => entry.carrier === event.carrier && entry.eventId === event.eventId);
    if (this.#eventKeys.has(key)) return { appended: false, event: existing && { ...existing } };
    const entry = Object.freeze({ ...event, storedAt: new Date().toISOString() });
    this.#eventKeys.add(key);
    this.#events.push(entry);
    return { appended: true, event: entry };
  }

  entries() { return this.#events.map((event) => ({ ...event })); }
  size() { return this.#events.length; }
}

export const InMemoryEventStore = AppendOnlyEventStore;
EOF_STORE
cat > "$app_dir/src/shipment-store.mjs" <<'EOF_PROJECTION'
function isLater(event, previous) {
  if (!previous || previous.status === "delivered") return !previous;
  if (event.sequence !== previous.sequence) return event.sequence > previous.sequence;
  return event.occurredAt > previous.occurredAt;
}

export class ShipmentProjectionStore {
  #shipments = new Map();

  project(event) {
    const previous = this.#shipments.get(event.shipmentId);
    if (!isLater(event, previous)) {
      return { previous: previous && { ...previous }, current: previous && { ...previous } };
    }
    const projection = {
      shipmentId: event.shipmentId,
      carrier: event.carrier,
      status: event.status,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      eventId: event.eventId,
    };
    this.#shipments.set(event.shipmentId, projection);
    return { previous: previous && { ...previous }, current: { ...projection } };
  }

  get(shipmentId) {
    const projection = this.#shipments.get(shipmentId);
    return projection ? { ...projection } : undefined;
  }
  entries() { return [...this.#shipments.values()].map((projection) => ({ ...projection })); }
}

export const InMemoryShipmentStore = ShipmentProjectionStore;
EOF_PROJECTION
cp "$app_dir/src/carrier-event-reconciliation.test.mjs" "$app_dir/src/carrier-event-reconciliation.test.mjs" 2>/dev/null || cp "$(dirname "$0")/../fixtures/carrier-event-reconciliation.test.mjs" "$app_dir/src/carrier-event-reconciliation.test.mjs"
