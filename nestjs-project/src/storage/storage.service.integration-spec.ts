import { randomUUID } from 'crypto';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { resetVideoTestBuckets } from '../test/storage';
import { MultipartUploadNotFoundError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;
const URL_TTL_SECONDS = 300;

function bytes(size: number, fill: number): Buffer {
  return Buffer.alloc(size, fill);
}

async function putPart(url: string, body: Buffer): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  expect(response.status).toBe(200);
  const eTag = response.headers.get('etag');
  expect(eTag).toBeTruthy();
  return eTag as string;
}

describe('StorageService (integration, MinIO)', () => {
  let moduleRef: TestingModule;
  let storage: StorageService;
  let config: ConfigType<typeof storageConfig>;
  const createdObjects: { bucket: string; key: string }[] = [];
  const openUploads: { key: string; uploadId: string }[] = [];

  function newKey(): string {
    return `it-${randomUUID()}/source`;
  }

  async function uploadObject(content: Buffer): Promise<string> {
    const key = newKey();
    await storage.putObject(
      config.videosBucket,
      key,
      content,
      'application/octet-stream',
    );
    createdObjects.push({ bucket: config.videosBucket, key });
    return key;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = moduleRef.get(StorageService);
    config = moduleRef.get(storageConfig.KEY);
  });

  afterAll(async () => {
    for (const { key, uploadId } of openUploads) {
      await storage.abortMultipartUpload(key, uploadId);
    }
    for (const { bucket, key } of createdObjects) {
      await storage.deleteObject(bucket, key);
    }
    await resetVideoTestBuckets(moduleRef);
    await moduleRef.close();
  });

  it('should run against the test-scoped buckets', () => {
    expect(config.videosBucket).toBe('videos-test');
    expect(config.thumbnailsBucket).toBe('thumbnails-test');
  });

  it('should complete a multipart upload made of PUTs to presigned part URLs', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    openUploads.push({ key, uploadId });
    const first = bytes(MIN_PART_SIZE, 1);
    const last = bytes(1234, 2);

    const firstUrl = await storage.presignUploadPart(
      key,
      uploadId,
      1,
      URL_TTL_SECONDS,
    );
    const lastUrl = await storage.presignUploadPart(
      key,
      uploadId,
      2,
      URL_TTL_SECONDS,
    );
    await putPart(firstUrl, first);
    await putPart(lastUrl, last);

    const parts = await storage.listAllParts(key, uploadId);
    expect(parts.map((p) => [p.partNumber, p.size])).toEqual([
      [1, first.length],
      [2, last.length],
    ]);

    await storage.completeMultipartUpload(key, uploadId, [...parts].reverse());
    openUploads.pop();
    createdObjects.push({ bucket: config.videosBucket, key });

    const head = await storage.headObject(config.videosBucket, key);
    expect(head).toEqual({
      contentLength: first.length + last.length,
      contentType: 'video/mp4',
    });
  });

  it('should throw MultipartUploadNotFoundError when completing an upload that is already gone', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const url = await storage.presignUploadPart(
      key,
      uploadId,
      1,
      URL_TTL_SECONDS,
    );
    const eTag = await putPart(url, bytes(1024, 3));
    await storage.abortMultipartUpload(key, uploadId);

    await expect(
      storage.completeMultipartUpload(key, uploadId, [{ partNumber: 1, eTag }]),
    ).rejects.toBeInstanceOf(MultipartUploadNotFoundError);
  });

  it('should list no parts for a freshly created multipart upload', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    openUploads.push({ key, uploadId });

    await expect(storage.listAllParts(key, uploadId)).resolves.toEqual([]);
  });

  it('should tolerate aborting an upload that was already aborted', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    await storage.abortMultipartUpload(key, uploadId);

    await expect(
      storage.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  });

  it('should sign every client-facing URL for the public endpoint', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    openUploads.push({ key, uploadId });

    const partUrl = await storage.presignUploadPart(
      key,
      uploadId,
      1,
      URL_TTL_SECONDS,
    );
    const getUrl = await storage.presignGetObject(key, URL_TTL_SECONDS, {
      client: 'public',
    });

    expect(partUrl.startsWith('http://minio.localhost:9000/')).toBe(true);
    expect(getUrl.startsWith('http://minio.localhost:9000/')).toBe(true);
    expect(partUrl).not.toContain('x-amz-checksum');
  });

  it('should serve a Range request on a public presigned GET with 206', async () => {
    const content = Buffer.from(
      Array.from({ length: 1000 }, (_, i) => i % 256),
    );
    const key = await uploadObject(content);
    const url = await storage.presignGetObject(key, URL_TTL_SECONDS, {
      client: 'public',
    });

    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(response.status).toBe(206);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body).toEqual(content.subarray(0, 100));
  });

  it('should reflect the requested Content-Disposition on the presigned GET', async () => {
    const key = await uploadObject(bytes(10, 3));
    const disposition = 'attachment; filename="aula.mp4"';
    const url = await storage.presignGetObject(key, URL_TTL_SECONDS, {
      client: 'public',
      disposition,
    });

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(disposition);
  });

  it('should sign internal presigned GETs for the internal endpoint', async () => {
    const key = await uploadObject(bytes(10, 4));
    const url = await storage.presignGetObject(key, URL_TTL_SECONDS, {
      client: 'internal',
    });

    expect(url.startsWith(`${config.endpoint}/`)).toBe(true);
    const response = await fetch(url);
    expect(response.status).toBe(200);
  });

  it('should serve a thumbnail anonymously through its unsigned public URL', async () => {
    const key = `it-${randomUUID()}/default.jpg`;
    await storage.putObject(
      config.thumbnailsBucket,
      key,
      bytes(10, 5),
      'image/jpeg',
    );
    createdObjects.push({ bucket: config.thumbnailsBucket, key });

    const url = storage.publicObjectUrl(config.thumbnailsBucket, key);
    const response = await fetch(url);

    expect(url).toBe(
      `http://minio.localhost:9000/${config.thumbnailsBucket}/${key}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
  });

  it('should return null from headObject for a missing key', async () => {
    await expect(
      storage.headObject(config.videosBucket, newKey()),
    ).resolves.toBeNull();
  });

  it('should delete an object', async () => {
    const key = await uploadObject(bytes(10, 6));

    await storage.deleteObject(config.videosBucket, key);

    await expect(storage.headObject(config.videosBucket, key)).resolves.toBe(
      null,
    );
  });
});
