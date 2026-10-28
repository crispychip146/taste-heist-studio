export class ProviderError extends Error {
  constructor(code, message, { retryable = false, status = 503 } = {}) {
    super(message); this.code = code; this.retryable = retryable; this.status = status;
  }
}
