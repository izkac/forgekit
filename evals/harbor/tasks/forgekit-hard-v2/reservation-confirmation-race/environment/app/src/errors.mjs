export class ReservationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "ReservationError";
    this.code = code;
    this.status = status;
  }
}
