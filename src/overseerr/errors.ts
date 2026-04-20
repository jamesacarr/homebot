export class OverseerrError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OverseerrError';
  }
}

export class OverseerrUnauthorizedError extends OverseerrError {
  constructor(message = 'Overseerr rejected the API key (401)') {
    super(message, 401);
    this.name = 'OverseerrUnauthorizedError';
  }
}

export class OverseerrNotFoundError extends OverseerrError {
  constructor(message = 'Overseerr returned 404') {
    super(message, 404);
    this.name = 'OverseerrNotFoundError';
  }
}

export class OverseerrTimeoutError extends OverseerrError {
  constructor(message = 'Overseerr request timed out') {
    super(message);
    this.name = 'OverseerrTimeoutError';
  }
}
