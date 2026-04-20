import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HealthServer } from '../src/health.js';
import { startHealthServer } from '../src/health.js';
import { silentLogger } from '../src/logging.js';

let server: HealthServer | undefined;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

describe('startHealthServer', () => {
  beforeEach(() => {
    server = undefined;
  });

  it('responds 200 with json {"status":"ok"} when all checks pass', async () => {
    server = await startHealthServer({
      checks: {
        botRunning: () => true,
        dbReachable: () => Promise.resolve(true),
      },
      logger: silentLogger,
      port: 0, // ephemeral
    });
    const url = baseUrl(server);

    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('responds 503 with the failed check name when the bot is not polling', async () => {
    server = await startHealthServer({
      checks: {
        botRunning: () => false,
        dbReachable: () => Promise.resolve(true),
      },
      logger: silentLogger,
      port: 0,
    });
    const res = await fetch(`${baseUrl(server)}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { failed: string[] };
    expect(body.failed).toContain('botRunning');
  });

  it('responds 503 when the DB check rejects', async () => {
    server = await startHealthServer({
      checks: {
        botRunning: () => true,
        dbReachable: () => Promise.reject(new Error('db down')),
      },
      logger: silentLogger,
      port: 0,
    });
    const res = await fetch(`${baseUrl(server)}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { failed: string[] };
    expect(body.failed).toContain('dbReachable');
  });

  it('responds 404 for unknown paths', async () => {
    server = await startHealthServer({
      checks: {
        botRunning: () => true,
        dbReachable: () => Promise.resolve(true),
      },
      logger: silentLogger,
      port: 0,
    });
    const res = await fetch(`${baseUrl(server)}/nope`);
    expect(res.status).toBe(404);
  });

  it('binds to loopback only so the endpoint is not reachable on the docker network', async () => {
    server = await startHealthServer({
      checks: {
        botRunning: () => true,
        dbReachable: () => Promise.resolve(true),
      },
      logger: silentLogger,
      port: 0,
    });
    expect(server.address.address).toBe('127.0.0.1');
  });
});

function baseUrl(s: HealthServer): string {
  const addr = s.address;
  return `http://127.0.0.1:${addr.port}`;
}
