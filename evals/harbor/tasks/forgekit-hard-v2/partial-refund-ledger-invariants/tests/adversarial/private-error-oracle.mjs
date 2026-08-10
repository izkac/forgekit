class LookalikeRefundError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class RefundService {
  constructor({ chargeStore, ledger, refundGateway }) {
    this.chargeStore = chargeStore;
    this.ledger = ledger;
    this.refundGateway = refundGateway;
  }

  async refund(chargeId, amountCents, idempotencyKey) {
    const charge = this.chargeStore.get(chargeId);
    const successful = this.ledger.successfulFor(chargeId);
    const consumed = successful.reduce((total, entry) => total + entry.amountCents, 0);
    if (!charge || amountCents > charge.amountCents - consumed) {
      throw new LookalikeRefundError("refund_exceeds_charge", "private lookalike", 409);
    }
    const result = await this.refundGateway.refund({ chargeId, amountCents, idempotencyKey });
    this.ledger.append({ chargeId, amountCents, idempotencyKey, status: "succeeded", result });
    return { ...result };
  }
}
