import { MemoryChargeStore } from "./charge-store.mjs";
import { createHttpServer } from "./http-app.mjs";
import { AppendOnlyRefundLedger } from "./refund-ledger.mjs";
import { RecordingRefundGateway } from "./refund-gateway.mjs";
import { RefundService } from "./refund-service.mjs";

export function createApplication({
  chargeStore = new MemoryChargeStore([{ id: "demo-charge", amountCents: 10_000 }]),
  ledger = new AppendOnlyRefundLedger(),
  refundGateway = new RecordingRefundGateway(),
} = {}) {
  const refundService = new RefundService({ chargeStore, ledger, refundGateway });
  return {
    chargeStore,
    ledger,
    refundGateway,
    refundService,
    server: createHttpServer({ refundService, chargeStore }),
  };
}
