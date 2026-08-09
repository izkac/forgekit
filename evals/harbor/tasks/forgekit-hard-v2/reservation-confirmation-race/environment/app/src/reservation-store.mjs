import { ReservationError } from "./errors.mjs";

export class MemoryReservationStore {
  #reservations;

  constructor(reservations = []) {
    this.#reservations = new Map(reservations.map((reservation) => [
      reservation.id,
      { ...reservation, status: reservation.status ?? "held" }
    ]));
  }

  get(id) {
    const reservation = this.#reservations.get(id);
    if (!reservation) throw new ReservationError("not_found", "Reservation not found", 404);
    return { ...reservation };
  }

  markConfirmed(id, { idempotencyKey, paymentId, confirmedAt }) {
    const current = this.#reservations.get(id);
    if (!current) throw new ReservationError("not_found", "Reservation not found", 404);
    if (current.status === "confirmed") {
      if (current.idempotencyKey !== idempotencyKey) {
        throw new ReservationError("already_confirmed", "Reservation was confirmed by another request");
      }
      return { ...current };
    }
    const confirmed = {
      ...current,
      status: "confirmed",
      idempotencyKey,
      paymentId,
      confirmedAt
    };
    this.#reservations.set(id, confirmed);
    return { ...confirmed };
  }
}
