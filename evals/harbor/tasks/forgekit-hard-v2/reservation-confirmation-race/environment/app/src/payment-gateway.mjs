export class MemoryPaymentGateway {
  #sequence = 0;
  charges = [];

  async charge({ reservationId, amount }) {
    const payment = {
      paymentId: `payment-${++this.#sequence}`,
      reservationId,
      amount
    };
    this.charges.push(payment);
    return payment;
  }
}
