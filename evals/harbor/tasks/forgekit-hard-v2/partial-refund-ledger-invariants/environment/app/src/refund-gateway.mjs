import { RefundGatewayError } from "./errors.mjs";

export class RecordingRefundGateway {
  constructor({ failuresRemaining = 0 } = {}) {
    this.failuresRemaining = failuresRemaining;
    this.calls = [];
  }

  async refund({ chargeId, amountCents, idempotencyKey }) {
    this.calls.push({ chargeId, amountCents, idempotencyKey });
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new RefundGatewayError();
    }
    return {
      refundId: `gateway-refund-${this.calls.length}`,
      chargeId,
      amountCents,
      idempotencyKey,
    };
  }
}
