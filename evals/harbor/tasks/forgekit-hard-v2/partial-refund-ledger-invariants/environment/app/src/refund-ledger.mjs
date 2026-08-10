export class AppendOnlyRefundLedger {
  #entries = [];

  append(entry) {
    const stored = { ...entry, recordedAt: entry.recordedAt ?? new Date().toISOString() };
    this.#entries.push(stored);
    return { ...stored };
  }

  entries() {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  successfulFor(chargeId) {
    return this.#entries
      .filter((entry) => entry.chargeId === chargeId && entry.status === "succeeded")
      .map((entry) => ({ ...entry }));
  }

  findSuccessfulByKey(chargeId, idempotencyKey) {
    const entry = this.#entries.find(
      (candidate) => candidate.chargeId === chargeId
        && candidate.status === "succeeded"
        && candidate.idempotencyKey === idempotencyKey
    );
    return entry ? { ...entry } : undefined;
  }
}
