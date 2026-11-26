import { getQueueToken } from '@nestjs/bullmq';
import { ModulesContainer } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { obliterateTestQueues } from '../test/queues';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

describe('WorkerModule (integration, Postgres + Redis)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();
  }, 30000);

  afterAll(async () => {
    await obliterateTestQueues(moduleRef);
    await moduleRef.close();
  });

  it('should connect to Postgres with the Video, Channel and User repositories', async () => {
    const dataSource = moduleRef.get(DataSource);

    expect(dataSource.isInitialized).toBe(true);
    for (const entity of [Video, Channel, User]) {
      expect(moduleRef.get(getRepositoryToken(entity))).toBeDefined();
    }
    // Resolving the Video → Channel → User relations needs all three entities.
    await expect(
      moduleRef
        .get(DataSource)
        .getRepository(Video)
        .find({ relations: { channel: { user: true } }, take: 1 }),
    ).resolves.toBeInstanceOf(Array);
  });

  it('should resolve the video queues on the Jest "test" prefix and the storage service', async () => {
    for (const name of [VIDEO_PROCESSING_QUEUE, VIDEO_MAINTENANCE_QUEUE]) {
      const queue = moduleRef.get<Queue>(getQueueToken(name), {
        strict: false,
      });
      expect(queue.opts.prefix).toBe('test');
      await expect(queue.getJobCounts()).resolves.toBeDefined();
    }
    expect(moduleRef.get(StorageService, { strict: false })).toBeDefined();
  });

  it('should register no controller and none of the HTTP-only modules', () => {
    const modules = [...moduleRef.get(ModulesContainer).values()];
    const moduleNames = modules.map((module) => module.metatype?.name);

    expect(modules.flatMap((module) => [...module.controllers.keys()])).toEqual(
      [],
    );
    expect(moduleNames).not.toContain('AuthModule');
    expect(moduleNames).not.toContain('ThrottlerModule');
    expect(moduleNames).not.toContain('VideosModule');
  });
});
