export class CarrierEventError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "CarrierEventError";
    this.code = code;
    this.status = status;
  }
}
