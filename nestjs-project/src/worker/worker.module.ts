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
import { MediaToolsService } from '../videos/processing/media-tools.service';
import { VideoMaintenanceConsumer } from '../videos/processing/video-maintenance.consumer';
import { VideoMaintenanceScheduler } from '../videos/processing/video-maintenance.scheduler';
import { VideoMaintenanceService } from '../videos/processing/video-maintenance.service';
import { VideoProcessingConsumer } from '../videos/processing/video-processing.consumer';
import { VideoProcessingService } from '../videos/processing/video-processing.service';

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
  providers: [
    MediaToolsService,
    VideoProcessingService,
    VideoProcessingConsumer,
    VideoMaintenanceService,
    VideoMaintenanceConsumer,
    VideoMaintenanceScheduler,
  ],
})
export class WorkerModule implements OnApplicationShutdown {
  private readonly logger = new Logger('VideoWorker');

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`Video worker stopped (${signal ?? 'no signal'})`);
  }
}
