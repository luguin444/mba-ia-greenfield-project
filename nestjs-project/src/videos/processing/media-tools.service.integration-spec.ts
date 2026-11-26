import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { resetVideoTestBuckets } from '../../test/storage';
import { thumbnailTimestamp } from './media-metadata.util';
import { InvalidMediaError } from './media-tools.errors';
import { MediaToolsService } from './media-tools.service';

const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const PRESIGN_TTL_SECONDS = 600;

describe('MediaToolsService (integration, ffprobe/ffmpeg + MinIO)', () => {
  let moduleRef: TestingModule;
  let service: MediaToolsService;
  let storage: StorageService;
  let videosBucket: string;

  /** Uploads a fixture to the test videos bucket and signs an internal GET for it. */
  async function internalUrlFor(fixture: string): Promise<string> {
    const key = `${randomUUID()}/source`;
    await storage.putObject(
      videosBucket,
      key,
      await readFile(join(FIXTURES_DIR, fixture)),
      'video/mp4',
    );
    return storage.presignGetObject(key, PRESIGN_TTL_SECONDS, {
      client: 'internal',
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaToolsService],
    }).compile();
    service = moduleRef.get(MediaToolsService);
    storage = moduleRef.get(StorageService);
    videosBucket = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).videosBucket;
  });

  afterAll(async () => {
    await resetVideoTestBuckets(moduleRef);
    await moduleRef.close();
  });

  it('should probe sample-2s.mp4 through an internal presigned URL', async () => {
    const url = await internalUrlFor('sample-2s.mp4');
    expect(new URL(url).host).toBe('minio:9000');

    const metadata = await service.probe(url);

    expect(metadata.durationSeconds).toBeCloseTo(2, 1);
    expect(metadata).toMatchObject({
      width: 160,
      height: 120,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    expect(metadata.formatName).toContain('mp4');
  });

  it('should write a JPEG frame at thumbnailTimestamp(2) = 0.2 s', async () => {
    const url = await internalUrlFor('sample-2s.mp4');
    const outPath = join(tmpdir(), `${randomUUID()}.jpg`);

    try {
      await service.extractFrame(url, thumbnailTimestamp(2), outPath);

      const jpeg = await readFile(outPath);
      // JPEG SOI marker + the first segment marker.
      expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect(jpeg.length).toBeGreaterThan(100);
    } finally {
      await rm(outPath, { force: true });
    }
  });

  it('should reject not-a-video.mp4 as invalid media (permanent)', async () => {
    const url = await internalUrlFor('not-a-video.mp4');

    await expect(service.probe(url)).rejects.toBeInstanceOf(InvalidMediaError);
  });
});
