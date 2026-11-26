import { Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { configModuleOptions } from '../config/config-load';
import databaseConfig from '../config/database.config';
import { buildTypeOrmOptions } from '../database/typeorm-options';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';

/**
 * Root module of the video worker process (`src/worker.ts`): queue consumers
 * only. No HTTP layer, so no controllers, `AuthModule` or throttler.
 *
 * `Video → Channel → User` relations need all three entities registered,
 * because `autoLoadEntities` only knows what `forFeature` declares.
 */
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) =>
        buildTypeOrmOptions(dbConfig),
    }),
    TypeOrmModule.forFeature([Video, Channel, User]),
    QueueModule,
    StorageModule,
  ],
})
export class WorkerModule implements OnApplicationShutdown {
  private readonly logger = new Logger('VideoWorker');

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`Video worker stopped (${signal ?? 'no signal'})`);
  }
}
