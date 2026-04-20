import { describe, expect, it } from 'vitest';

import {
  decodeCallbackData,
  encodeAccessDecisionCallback,
  encodePickCallback,
  encodeRequestAccessCallback,
} from '../src/callbacks.js';

describe('callback encode/decode round-trips', () => {
  it('encodes and decodes a pick callback for a movie', () => {
    const encoded = encodePickCallback({ mediaType: 'movie', tmdbId: 414906 });
    expect(encoded).toBe('pick:414906:movie');

    const decoded = decodeCallbackData(encoded);
    expect(decoded).toEqual({
      kind: 'pick',
      mediaType: 'movie',
      tmdbId: 414906,
    });
  });

  it('encodes and decodes a pick callback for a tv series', () => {
    const encoded = encodePickCallback({ mediaType: 'tv', tmdbId: 136315 });
    expect(encoded).toBe('pick:136315:tv');
    expect(decodeCallbackData(encoded)).toEqual({
      kind: 'pick',
      mediaType: 'tv',
      tmdbId: 136315,
    });
  });

  it('encodes and decodes an approve callback with the requester id', () => {
    const encoded = encodeAccessDecisionCallback('approve', 12345);
    expect(encoded).toBe('approve:12345');
    expect(decodeCallbackData(encoded)).toEqual({
      kind: 'approve',
      requesterId: 12345,
    });
  });

  it('encodes and decodes a deny callback with the requester id', () => {
    const encoded = encodeAccessDecisionCallback('deny', 99999);
    expect(encoded).toBe('deny:99999');
    expect(decodeCallbackData(encoded)).toEqual({
      kind: 'deny',
      requesterId: 99999,
    });
  });

  it('encodes the access-request button as the literal string per plan.md', () => {
    expect(encodeRequestAccessCallback()).toBe('access_request');
    expect(decodeCallbackData('access_request')).toEqual({
      kind: 'access_request',
    });
  });
});

describe('decodeCallbackData rejects malformed input', () => {
  it('returns null for an unknown prefix', () => {
    expect(decodeCallbackData('reboot:1:2')).toBeNull();
  });

  it('returns null for a pick missing fields', () => {
    expect(decodeCallbackData('pick:42')).toBeNull();
  });

  it('returns null for a pick with a non-numeric tmdbId', () => {
    expect(decodeCallbackData('pick:abc:movie')).toBeNull();
  });

  it('returns null for a pick with an unknown mediaType', () => {
    expect(decodeCallbackData('pick:42:audiobook')).toBeNull();
  });

  it('returns null for an approve missing the requester id', () => {
    expect(decodeCallbackData('approve:')).toBeNull();
    expect(decodeCallbackData('approve')).toBeNull();
  });

  it('returns null for a deny with a non-numeric requester id', () => {
    expect(decodeCallbackData('deny:abc')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(decodeCallbackData('')).toBeNull();
  });

  it('returns null for undefined-style garbage', () => {
    expect(decodeCallbackData('::')).toBeNull();
  });
});

describe('encoded payloads stay within the 64-byte Telegram callback_data limit', () => {
  // Telegram caps callback_data at 64 bytes. A tmdbId is at most 8 digits in
  // practice (TMDB IDs sit in the tens of thousands to low millions), and a
  // telegram user id is at most 19 digits (Twitter-snowflake-style 64-bit).
  it('keeps the longest realistic pick under 64 bytes', () => {
    const big = encodePickCallback({ mediaType: 'movie', tmdbId: 99_999_999 });
    expect(Buffer.byteLength(big, 'utf8')).toBeLessThan(64);
  });

  it('keeps the longest realistic approve under 64 bytes', () => {
    // Telegram user ids are 64-bit integers in the protocol but are below
    // Number.MAX_SAFE_INTEGER (2^53 - 1) for any account that exists today.
    // Use the safe-integer ceiling as the worst case.
    const big = encodeAccessDecisionCallback(
      'approve',
      Number.MAX_SAFE_INTEGER,
    );
    expect(Buffer.byteLength(big, 'utf8')).toBeLessThan(64);
  });
});
