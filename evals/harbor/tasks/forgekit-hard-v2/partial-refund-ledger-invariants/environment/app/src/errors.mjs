export class RefundError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "RefundError";
    this.code = code;
    this.status = status;
  }
}

export class RefundGatewayError extends Error {
  constructor(message = "Refund gateway failed") {
    super(message);
    this.name = "RefundGatewayError";
  }
}
