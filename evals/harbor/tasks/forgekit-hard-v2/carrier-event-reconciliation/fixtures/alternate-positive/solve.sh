#!/bin/sh
set -eu
app_dir=${HARBOR_APP_DIR:-/app}
base=$(dirname "$0")
# Install distinct store implementations rather than importing the oracle.
cat > "$app_dir/src/event-store.mjs" <<'EOF_STORE'
export class AppendOnlyEventStore {
  #events = [];
  #keys = new Set();

  append(event) {
    const key = `${event.carrier}/${event.eventId}`;
    if (this.#keys.has(key)) {
      return { appended: false, event: this.#events.find((entry) => `${entry.carrier}/${entry.eventId}` === key) };
    }
    const stored = Object.freeze({ ...event, storedAt: new Date().toISOString() });
    this.#keys.add(key);
    this.#events.push(stored);
    return { appended: true, event: stored };
  }

  entries() {
    return this.#events.map((event) => ({ ...event }));
  }

  size() {
    return this.#events.length;
  }
}

export const InMemoryEventStore = AppendOnlyEventStore;
EOF_STORE

cat > "$app_dir/src/shipment-store.mjs" <<'EOF_PROJECTION'
function shouldReplace(next, previous) {
  if (!previous) return true;
  if (previous.status === "delivered") return false;
  if (next.sequence !== previous.sequence) return next.sequence > previous.sequence;
  return next.occurredAt > previous.occurredAt;
}

export class ShipmentProjectionStore {
  #shipments = new Map();

  project(event) {
    const previous = this.#shipments.get(event.shipmentId);
    if (!shouldReplace(event, previous)) {
      return {
        previous: previous && { ...previous },
        current: previous && { ...previous },
      };
    }
    const next = {
      shipmentId: event.shipmentId,
      carrier: event.carrier,
      status: event.status,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      eventId: event.eventId,
    };
    this.#shipments.set(event.shipmentId, next);
    return {
      previous: previous && { ...previous },
      current: { ...next },
    };
  }

  get(shipmentId) {
    const projection = this.#shipments.get(shipmentId);
    return projection && { ...projection };
  }

  entries() {
    return [...this.#shipments.values()].map((projection) => ({ ...projection }));
  }
}

export const InMemoryShipmentStore = ShipmentProjectionStore;
EOF_PROJECTION

cp "$base/../carrier-event-reconciliation.test.mjs" "$app_dir/src/carrier-event-reconciliation.test.mjs"
cat > "$app_dir/src/reconciliation-service.mjs" <<'EOF_SERVICE'
const comesAfter = (candidate, current) => {
  if (!current || current.status === "delivered") return !current;
  return candidate.sequence > current.sequence
    || (candidate.sequence === current.sequence && candidate.occurredAt > current.occurredAt);
};

export class ReconciliationService {
  constructor({ normalizers, eventStore, shipmentStore }) {
    this.normalizers = normalizers;
    this.eventStore = eventStore;
    this.shipmentStore = shipmentStore;
    this.acceptedKeys = new Set();
  }

  async reconcile(carrier, payload) {
    const event = this.normalizers.normalize(carrier, payload);
    const identity = `${event.carrier}/${event.eventId}`;
    if (this.acceptedKeys.has(identity)) return { accepted: false, reason: "duplicate", event };
    const outcome = await this.eventStore.append(event);
    if (!outcome.appended) {
      this.acceptedKeys.add(identity);
      return { accepted: false, reason: "duplicate", event: outcome.event };
    }
    this.acceptedKeys.add(identity);
    const previous = this.shipmentStore.get(event.shipmentId);
    const projection = comesAfter(event, previous) ? (await this.shipmentStore.project(event)).current : previous;
    return { accepted: true, event, projection };
  }
}
export const CarrierReconciliationService = ReconciliationService;
EOF_SERVICE
