export class DocumentError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
    this.status = status;
  }
}
