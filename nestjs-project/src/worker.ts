import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import queueConfig from './config/queue.config';
import { WorkerModule } from './worker/worker.module';

/**
 * Video worker entrypoint: a Nest application context with no HTTP listener.
 * Shutdown hooks let SIGTERM (`docker compose stop`) close the BullMQ workers
 * and the DB pool cleanly.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  const queue = app.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  new Logger('VideoWorker').log(
    `Video worker started (redis ${queue.host}:${queue.port}, queue prefix "${queue.prefix}")`,
  );
}
void bootstrap();
