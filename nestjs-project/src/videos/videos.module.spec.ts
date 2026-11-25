import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile with its repository, channels lookup, storage and queue', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(moduleRef.get(getRepositoryToken(Video))).toBeDefined();
    expect(moduleRef.get(ChannelsService, { strict: false })).toBeDefined();
    expect(moduleRef.get(StorageService, { strict: false })).toBeDefined();
    expect(
      moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE), { strict: false }),
    ).toBeDefined();

    await moduleRef.close();
  }, 30000);
});
