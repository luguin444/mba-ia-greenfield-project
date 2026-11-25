import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';

/**
 * Redis connection and the video queues, shared by the API (producer only)
 * and the worker. `@Processor` classes are registered only by the worker.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
        prefix: config.prefix,
      }),
    }),
    BullModule.registerQueue(
      { name: VIDEO_PROCESSING_QUEUE },
      { name: VIDEO_MAINTENANCE_QUEUE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
