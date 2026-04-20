/**
 * Base Overseerr HTTP error. Carries everything we know from the response so
 * orchestrator-layer logic can distinguish between business errors (e.g.
 * "request already exists") and infrastructure errors (e.g. 5xx) by looking
 * at `status` and `errorCode`.
 */
export class OverseerrError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly errorCode?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'OverseerrError';
  }
}

export class OverseerrUnauthorizedError extends OverseerrError {
  constructor(
    message = 'Overseerr rejected the API key (401)',
    errorCode?: number,
    body?: unknown,
  ) {
    super(message, 401, errorCode, body);
    this.name = 'OverseerrUnauthorizedError';
  }
}

export class OverseerrNotFoundError extends OverseerrError {
  constructor(
    message = 'Overseerr returned 404',
    errorCode?: number,
    body?: unknown,
  ) {
    super(message, 404, errorCode, body);
    this.name = 'OverseerrNotFoundError';
  }
}

export class OverseerrTimeoutError extends OverseerrError {
  constructor(message = 'Overseerr request timed out') {
    super(message);
    this.name = 'OverseerrTimeoutError';
  }
}
