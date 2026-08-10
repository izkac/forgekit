import { CarrierEventError } from "./errors.mjs";

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CarrierEventError("malformed_event", `${field} must be a non-empty string`);
  }
  return value;
}

function requiredSequence(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new CarrierEventError("malformed_event", "provider sequence must be a non-negative integer");
  }
  return value;
}

function requiredOccurred(value) {
  const date = new Date(requiredString(value, "occurredAt"));
  if (Number.isNaN(date.valueOf())) {
    throw new CarrierEventError("malformed_event", "occurredAt must be an ISO timestamp");
  }
  return date.toISOString();
}

function normalizeDhl(payload) {
  if (!payload || typeof payload !== "object") throw new CarrierEventError("malformed_event", "payload must be an object");
  return {
    carrier: "dhl",
    eventId: requiredString(payload.event_id, "event_id"),
    shipmentId: requiredString(payload.tracking_number, "tracking_number"),
    status: requiredString(payload.event, "event"),
    sequence: requiredSequence(payload.sequence),
    occurredAt: requiredOccurred(payload.occurred_at),
  };
}

function normalizeFedex(payload) {
  if (!payload || typeof payload !== "object") throw new CarrierEventError("malformed_event", "payload must be an object");
  const status = requiredString(payload.state, "state").toLowerCase();
  return {
    carrier: "fedex",
    eventId: requiredString(payload.id, "id"),
    shipmentId: requiredString(payload.trackingCode, "trackingCode"),
    status,
    sequence: requiredSequence(payload.providerSequence),
    occurredAt: requiredOccurred(payload.timestamp),
  };
}

export const defaultNormalizers = Object.freeze({ dhl: normalizeDhl, fedex: normalizeFedex });

export class CarrierNormalizerRegistry {
  #normalizers;

  constructor(normalizers = defaultNormalizers) {
    this.#normalizers = new Map(Object.entries(normalizers));
  }

  normalize(carrier, payload) {
    const normalizer = this.#normalizers.get(carrier);
    if (!normalizer) throw new CarrierEventError("unknown_carrier", `No normalizer configured for ${carrier}`);
    const event = normalizer(payload);
    if (!event || event.carrier !== carrier) {
      throw new CarrierEventError("malformed_event", "Normalizer returned an invalid carrier event");
    }
    return Object.freeze({ ...event });
  }

  carriers() {
    return [...this.#normalizers.keys()];
  }
}
