import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplication } from "./app.mjs";
import { MemoryChargeStore } from "./charge-store.mjs";
import { AppendOnlyRefundLedger } from "./refund-ledger.mjs";
import { RecordingRefundGateway } from "./refund-gateway.mjs";
import { RefundError } from "./errors.mjs";

test("alternate verifier enforces cumulative refund budget", async () => {
  const charge = { id: "alternate-charge", amountCents: 8_901 };
  const ledger = new AppendOnlyRefundLedger();
  const gateway = new RecordingRefundGateway();
  const app = createApplication({
    chargeStore: new MemoryChargeStore([charge]),
    ledger,
    refundGateway: gateway,
  });
  await app.refundService.refund(charge.id, 1_111, "alternate-first");
  await app.refundService.refund(charge.id, 2_222, "alternate-second");
  await app.refundService.refund(charge.id, 5_568, "alternate-final");
  await assert.rejects(
    () => app.refundService.refund(charge.id, 1, "alternate-over"),
    (error) => error instanceof RefundError && error.code === "refund_exceeds_charge",
  );
  assert.equal(ledger.entries().length, 3);
  assert.equal(gateway.calls.length, 3);
  assert.deepEqual(ledger.successfulFor(charge.id).map((entry) => entry.amountCents), [1_111, 2_222, 5_568]);
});
