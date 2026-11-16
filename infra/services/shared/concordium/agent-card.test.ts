import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { assertCardHash, isPubliclyHostableUri, sha256Hex, verifyServedCard } from './agent-card';

const CARD = '{\n  "name": "TradeWizard Trade Agent",\n  "version": "1.0.0"\n}';
const CARD_HASH = createHash('sha256').update(CARD).digest('hex');

describe('sha256Hex', () => {
  it('hashes bytes exactly as served', () => {
    expect(sha256Hex(CARD)).toBe(CARD_HASH);
    expect(sha256Hex(Buffer.from(CARD, 'utf8'))).toBe(CARD_HASH);
  });

  it('is sensitive to whitespace, which is why nothing re-serialises the card', () => {
    expect(sha256Hex('{"a":1}')).not.toBe(sha256Hex('{"a": 1}'));
  });
});

describe('assertCardHash', () => {
  it('accepts the exact string that will be served', () => {
    expect(() => assertCardHash(CARD, CARD_HASH)).not.toThrow();
    expect(() => assertCardHash(CARD, CARD_HASH.toUpperCase())).not.toThrow();
  });

  it('rejects a re-serialised card', () => {
    expect(() => assertCardHash(JSON.stringify(JSON.parse(CARD)), CARD_HASH)).toThrow(/hash mismatch/);
  });
});

describe('verifyServedCard', () => {
  const fetchReturning = (body: string, status = 200) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it('passes when the URL serves the pinned bytes', async () => {
    const result = await verifyServedCard('https://example.com/card.json', CARD_HASH, {
      fetchImpl: fetchReturning(CARD),
    });
    expect(result.ok).toBe(true);
    expect(result.servedHash).toBe(CARD_HASH);
  });

  it('fails when the served bytes drifted from the pinned hash', async () => {
    const result = await verifyServedCard('https://example.com/card.json', CARD_HASH, {
      fetchImpl: fetchReturning(JSON.stringify(JSON.parse(CARD))),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/do not match/);
    expect(result.servedHash).toBeDefined();
  });

  it('fails on a non-200 card URL', async () => {
    const result = await verifyServedCard('https://example.com/card.json', CARD_HASH, {
      fetchImpl: fetchReturning('not found', 404),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.reason).toMatch(/HTTP 404/);
  });

  it('fails instead of throwing when the host is unreachable', async () => {
    const result = await verifyServedCard('https://example.com/card.json', CARD_HASH, {
      fetchImpl: (async () => {
        throw new TypeError('getaddrinfo ENOTFOUND');
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unreachable/);
  });
});

describe('isPubliclyHostableUri', () => {
  it.each([
    'https://kls.kinganlogic.com/.well-known/agent-card.json',
    'https://tradewizard.app/api/agents/1/card.json',
  ])('accepts %s', (uri) => {
    expect(isPubliclyHostableUri(uri)).toBe(true);
  });

  it.each([
    ['http://example.com/card.json', 'plain http'],
    ['https://localhost:8080/card.json', 'loopback host'],
    ['https://127.0.0.1/card.json', 'loopback ip'],
    ['https://192.168.1.20/card.json', 'private ip 192.168'],
    ['https://172.20.0.5/card.json', 'private ip 172.16-31'],
    ['https://100.120.140.87:3000/api/card.json', 'carrier-grade nat, seen in the wild'],
    ['/card.json', 'relative path'],
    ['ftp://example.com/card.json', 'wrong scheme'],
  ])('rejects %s (%s)', (uri) => {
    expect(isPubliclyHostableUri(uri)).toBe(false);
  });
});
