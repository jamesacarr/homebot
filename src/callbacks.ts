import type { OverseerrMediaType } from './overseerr/client.js';

/**
 * Telegram caps `callback_data` at 64 bytes. The encodings below pack each
 * payload comfortably under that limit:
 *
 * - `pick:<tmdbId>:<mediaType>` for the disambiguation picker.
 * - `approve:<requesterId>` and `deny:<requesterId>` for owner-driven access
 *   decisions; defensive `from.id === TELEGRAM_OWNER_ID` enforcement
 *   lives in the handler.
 * - `access_request` (no payload) for the unknown-user "request access" tap.
 */

export type DecodedCallback =
  | { kind: 'pick'; tmdbId: number; mediaType: OverseerrMediaType }
  | { kind: 'approve'; requesterId: number }
  | { kind: 'deny'; requesterId: number }
  | { kind: 'access_request' };

export interface PickPayload {
  tmdbId: number;
  mediaType: OverseerrMediaType;
}

export function encodePickCallback(payload: PickPayload): string {
  return `pick:${payload.tmdbId}:${payload.mediaType}`;
}

export function encodeAccessDecisionCallback(
  decision: 'approve' | 'deny',
  requesterId: number,
): string {
  return `${decision}:${requesterId}`;
}

export function encodeRequestAccessCallback(): string {
  return 'access_request';
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined || value.length === 0) {
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

function parseMediaType(value: string | undefined): OverseerrMediaType | null {
  return value === 'movie' || value === 'tv' ? value : null;
}

export function decodeCallbackData(raw: string): DecodedCallback | null {
  if (raw === 'access_request') {
    return { kind: 'access_request' };
  }
  const parts = raw.split(':');
  const head = parts[0];

  if (head === 'pick' && parts.length === 3) {
    const tmdbId = parsePositiveInt(parts[1]);
    const mediaType = parseMediaType(parts[2]);
    if (tmdbId === null || mediaType === null) {
      return null;
    }
    return { kind: 'pick', mediaType, tmdbId };
  }

  if ((head === 'approve' || head === 'deny') && parts.length === 2) {
    const requesterId = parsePositiveInt(parts[1]);
    if (requesterId === null) {
      return null;
    }
    return { kind: head, requesterId };
  }

  return null;
}
