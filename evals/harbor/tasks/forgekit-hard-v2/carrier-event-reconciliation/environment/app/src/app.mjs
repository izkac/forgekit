import { createHttpServer } from "./http-app.mjs";
import { AppendOnlyEventStore } from "./event-store.mjs";
import { CarrierNormalizerRegistry, defaultNormalizers } from "./normalizers.mjs";
import { ReconciliationService } from "./reconciliation-service.mjs";
import { ShipmentProjectionStore } from "./shipment-store.mjs";

export function createApplication({
  normalizers = defaultNormalizers,
  eventStore = new AppendOnlyEventStore(),
  shipmentStore = new ShipmentProjectionStore(),
} = {}) {
  const normalizerRegistry = normalizers instanceof CarrierNormalizerRegistry
    ? normalizers
    : new CarrierNormalizerRegistry(normalizers);
  const reconciliationService = new ReconciliationService({
    normalizers: normalizerRegistry,
    eventStore,
    shipmentStore,
  });
  return {
    normalizerRegistry,
    normalizers: normalizerRegistry,
    eventStore,
    shipmentStore,
    reconciliationService,
    server: createHttpServer({ reconciliationService }),
  };
}
