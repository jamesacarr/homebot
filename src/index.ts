import { getModel } from '@mariozechner/pi-ai';

import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/index.js';
import { startHealthServer } from './health.js';
import { createOrchestrator } from './llm/orchestrator.js';
import { SYSTEM_PROMPT } from './llm/prompt.js';
import { createToolDispatcher } from './llm/tools.js';
import type { LogLevel } from './logging.js';
import { createLogger } from './logging.js';
import { createOverseerrClient } from './overseerr/client.js';
import { runSanityChecks, SanityCheckError } from './sanity-checks.js';
import { createBot } from './telegram/bot.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({
    level: config.logLevel as LogLevel,
    name: 'homebot',
  });

  const db = createDb(config.dbPath);
  await runMigrations(db);

  const overseerr = createOverseerrClient({
    apiKey: config.overseerrApiKey,
    baseUrl: config.overseerrUrl,
  });

  // pi-ai's `getModel` requires literal types for full inference. We type-cast
  // because provider/model come from runtime config.
  const llmModel = getModel(
    config.llmProvider as never,
    config.llmModel as never,
  );

  const orchestrate = createOrchestrator({
    llmModel,
    logger,
    overseerr,
    systemPrompt: SYSTEM_PROMPT,
    thinkingLevel: config.llmThinkingLevel,
  });

  const toolDispatcher = createToolDispatcher({ logger, overseerr });

  const bot = createBot({
    capUsd: config.dailyCostCapUsd,
    db,
    logger,
    maxTurnsInHistory: config.maxTurnsInHistory,
    orchestrate,
    overseerr,
    ownerTelegramUserId: config.ownerTelegramUserId,
    token: config.telegramBotToken,
    toolDispatcher,
  });

  // Sanity checks before we start polling. If any fail, log the full set and
  // exit non-zero so the container restarts with the operator's attention.
  try {
    await runSanityChecks({
      bot,
      db,
      logger,
      overseerr,
      ownerTelegramUserId: config.ownerTelegramUserId,
    });
  } catch (error) {
    if (error instanceof SanityCheckError) {
      for (const issue of error.issues) {
        logger.error({ check: issue.check, err: issue.message }, 'startup');
      }
    } else {
      logger.error({ err: error }, 'startup');
    }
    process.exit(1);
  }

  // Health server + bot polling run for the lifetime of the process.
  const healthServer = await startHealthServer({
    checks: {
      botRunning: () => bot.isRunning(),
      dbReachable: async () => {
        await db.selectNoFrom(eb => eb.lit(1).as('one')).executeTakeFirst();
        return true;
      },
    },
    logger,
    port: 3000,
  });

  logger.info(
    {
      llmModel: config.llmModel,
      llmProvider: config.llmProvider,
      version: process.env.npm_package_version ?? 'dev',
    },
    'startup',
  );

  const shutdown = async (reason: string): Promise<void> => {
    logger.info({ reason }, 'shutdown');
    try {
      await bot.stop();
    } catch (error) {
      logger.warn({ err: error }, 'shutdown');
    }
    try {
      await healthServer.stop();
    } catch (error) {
      logger.warn({ err: error }, 'shutdown');
    }
    try {
      await db.destroy();
    } catch (error) {
      logger.warn({ err: error }, 'shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  // Long polling — blocks until bot.stop() resolves.
  await bot.start();
}

main().catch(error => {
  // Use stderr directly here; the logger may not have been created yet.
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
