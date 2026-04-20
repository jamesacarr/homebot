import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Logger } from './logging.js';

export interface HealthChecks {
  /** Returns true if grammY is actively polling. */
  botRunning(): boolean;
  /** Resolves true if the DB answers a trivial query within the request. */
  dbReachable(): Promise<boolean>;
}

export interface StartHealthServerOptions {
  port: number;
  checks: HealthChecks;
  logger: Logger;
}

export interface HealthServer {
  address: { address: string; port: number };
  stop(): Promise<void>;
}

interface CheckOutcome {
  name: string;
  ok: boolean;
}

async function runChecks(checks: HealthChecks): Promise<CheckOutcome[]> {
  // Run the synchronous and async checks in parallel; both must pass for 200.
  const dbPromise = checks
    .dbReachable()
    .then(ok => ({ name: 'dbReachable', ok }))
    .catch(() => ({ name: 'dbReachable', ok: false }));
  const botOk = { name: 'botRunning', ok: checks.botRunning() };
  const dbOk = await dbPromise;
  return [botOk, dbOk];
}

export function startHealthServer(
  options: StartHealthServerOptions,
): Promise<HealthServer> {
  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (req.url !== '/health') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const outcomes = await runChecks(options.checks);
    const failed = outcomes.filter(o => !o.ok).map(o => o.name);
    res.setHeader('Content-Type', 'application/json');
    if (failed.length === 0) {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    options.logger.warn({ check: failed.join(',') }, 'health_check_failed');
    res.statusCode = 503;
    res.end(JSON.stringify({ failed, status: 'unhealthy' }));
  };

  const server = createServer((req, res) => {
    // Errors inside the async handler must not leak as unhandled rejections;
    // 500 + log + close is the safe default.
    handler(req, res).catch(error => {
      options.logger.error({ err: error }, 'health_check_failed');
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
  });

  return new Promise<HealthServer>((resolve, reject) => {
    server.once('error', reject);
    // Bind to loopback only so the endpoint is not exposed on `media-net`;
    // only the in-container `curl` healthcheck reaches it.
    server.listen(options.port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        address: { address: addr.address, port: addr.port },
        stop: () =>
          new Promise<void>(resolveStop => {
            server.close(() => resolveStop());
          }),
      });
    });
  });
}
