---
libs:
  "bullmq":
    version: "^6.7.10"
    context7_id: "/taskforcesh/bullmq/v6.5.3"
    fetched_at: "2026-11-24T21:09:40-03:00"
  "ioredis":
    version: "^6.1.0"
    context7_id: "/redis/ioredis/v6.0.0"
    fetched_at: "2026-11-24T23:40:00-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-24T21:09:40-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1177.0"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-24T21:09:40-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1177.0"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-24T21:09:40-03:00"
  "@nestjs/throttler":
    version: "^6.5.0"
    context7_id: "/nestjs/throttler/v6.7.1"
    fetched_at: "2026-11-24T21:09:40-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-24T23:28:59-03:00"
---

# Library References — phase-03-videos

Versions: `bullmq`, `@nestjs/bullmq`, `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are not installed yet. Each version is the npm `latest` checked on 2026-11-24 (`npm view`), except `@nestjs/bullmq` (see below). `@nestjs/throttler` is already installed at 6.5.0 (`^6.5.0` in `package.json`).

**Doc/version discrepancies (flagged, not blocking):**

- `bullmq` docs come from context7 v6.5.3, the nearest indexed version to 6.7.10. Both are in the same v6 major (Job Schedulers API, no legacy repeatable jobs).
- `@aws-sdk/*` docs come from context7 v3.1153.0, the nearest indexed version to 3.1177.0. Same v3 line; the APIs used here (`S3Client`, multipart commands, `getSignedUrl`) are stable across these minors.
- `@nestjs/throttler` docs come from v6.7.1, while 6.5.0 is installed. Phase 03 uses only `@SkipThrottle()`, which behaves the same in both.
- `@nestjs/bullmq` has no versioned context7 index (`/nestjs/bull` repo docs). Cross-check with the NestJS v11 queues technique (`/nestjs/docs.nestjs.com`, `techniques/queues`). The decisions doc's Sources cite `12.0.2` (npm `latest` at research time). **Pinned to `11.0.5` at the final pre-implementation review (2026-11-25):** `@nestjs/bullmq@12.x` and `@nestjs/bull-shared@12.x` ship `"type": "module"` (ESM-only, `npm view @nestjs/bullmq@12.0.2 type`). The project's Jest (ts-jest, CommonJS, default `transformIgnorePatterns`) cannot load them: a real install with `jest@30.3.0` fails with `SyntaxError: Unexpected token 'export'`, while `11.0.5` passes. `11.0.5` is CommonJS, peers `bullmq ^3||^4||^5||^6` and `@nestjs/core ^10||^11`, and exports the same API used here (`BullModule.forRootAsync`, `registerQueue`, `Processor`, `WorkerHost`, `InjectQueue`, `getQueueToken`, `OnWorkerEvent`). `tsc --noEmit` does not catch the ESM issue; only Jest does.

## ioredis

Used by: `phase-03-videos/TD-01` (Redis driver required by bullmq 6; Note on TD-01). Added at the pre-implementation review: `bullmq@6.7.10` declares `ioredis` as an **optional** peer (`peerDependenciesMeta.ioredis.optional: true`), so it must be installed explicitly. bullmq's own dev pin is `6.0.0`; npm `latest` is `6.1.0` (2026-11-24); context7 indexes v6.0.0 (same major).

- Never instantiate `ioredis` directly in Phase 03: pass plain connection options (`{ host, port }`) to `BullModule.forRootAsync` and let BullMQ create the clients.
- Workers: BullMQ forces `maxRetriesPerRequest: null` on worker connections. Do not override it (bullmq docs, "going-to-production").
- Producers: with Redis down, `queue.add` waits for reconnection instead of failing. Bound it with a timeout in the request path (see the plan, `complete` step 7).

## bullmq

Used by: `phase-03-videos/TD-01` (queue), `phase-03-videos/TD-12` (retries + maintenance sweep via Job Scheduler).

### Retries with exponential backoff

```typescript
await queue.add(
  'process-video',
  { videoId },
  {
    jobId: videoId,            // idempotent enqueue / dedup (TD-01, TD-12)
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
);
```

Exponential backoff retries after `2 ^ (attempts - 1) * delay` ms. A job is deduplicated by a custom `jobId`: adding a job whose `jobId` already exists in the queue does nothing.

### Job Schedulers (v6 replaces repeatable jobs)

```typescript
await queue.upsertJobScheduler(
  'video-maintenance-sweep',          // scheduler id: upsert is idempotent
  { every: sweepIntervalMs },         // `every` OR `pattern`, never both
  { name: 'sweep', data: {}, opts: { attempts: 1 } },
);
```

- v6 removed the legacy `repeat` options. Map `repeat.every` to `upsertJobScheduler(..., { every })` and `repeat.pattern` to `{ pattern }`.
- Production: Redis must run with `maxmemory-policy noeviction` (decisions doc, "going-to-production").

## @nestjs/bullmq

Pinned: `^11.0.5` (not 12.x: ESM-only, breaks Jest; see the discrepancy note above).

Used by: `phase-03-videos/TD-01`, `phase-03-videos/TD-02` (separate worker entrypoint loads `WorkerModule`), `phase-03-videos/TD-12`.

### Root connection (async, from config)

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],                      // registerAs convention (phase 01)
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port }, // host = Compose service name (e.g. `redis`)
  }),
});
BullModule.registerQueue({ name: 'video-processing' }, { name: 'video-maintenance' });
```

### Producer and consumer

```typescript
// Producer (API)
constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

// Consumer (worker only)
@Processor('video-processing', { concurrency: 2 })
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // throwing fails the job → retried per job opts (attempts/backoff)
  }
}
```

- `@Processor` classes must extend `WorkerHost` and implement `process(job, token?)`. Otherwise registration throws `InvalidProcessorClassError`.
- `this.worker` is only available after registration (`onModuleInit`), so use it in `onApplicationBootstrap` or later, never in the constructor.
- Register processors only in the worker's module (TD-02). The API process imports the queue (producer) without the consumer.

## @aws-sdk/client-s3

Used by: `phase-03-videos/TD-05` (multipart), `phase-03-videos/TD-07` (buckets/endpoints), `phase-03-videos/TD-10` (GetObject for presign), `phase-03-videos/TD-12` (sweep: `ListParts` / `AbortMultipartUpload`).

### Client against MinIO

```typescript
new S3Client({
  endpoint: cfg.endpoint,          // S3_ENDPOINT (internal, `http://minio:9000`) for SDK calls
  region: cfg.region,
  forcePathStyle: true,            // v2 `s3ForcePathStyle` renamed in v3
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

- Browser-facing presigned URLs must be signed by a second client configured with `S3_PUBLIC_ENDPOINT` (`http://minio.localhost:9000`, TD-16). The host is part of the signature, so you cannot rewrite it afterwards.
- Multipart commands used in TD-05: `CreateMultipartUploadCommand`, `UploadPartCommand` (presigned, browser PUTs), `ListPartsCommand` (resume + completion), `CompleteMultipartUploadCommand` (ordered `{ ETag, PartNumber }` list), `AbortMultipartUploadCommand` (sweep). S3 limits: 5 MiB minimum part size (except the last part), 10,000 parts maximum.
- Browser PUTs need bucket CORS exposing `ETag` (decisions doc sources: AWS CORS + MinIO CORS).

## @aws-sdk/s3-request-presigner

Used by: `phase-03-videos/TD-04` (worker presigned GET), `phase-03-videos/TD-05` (presigned `UploadPart`), `phase-03-videos/TD-07`, `phase-03-videos/TD-10` (playback/download URLs).

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const partUrl = await getSignedUrl(
  publicS3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: partUrlTtlSeconds },
);

const downloadUrl = await getSignedUrl(
  publicS3,
  new GetObjectCommand({
    Bucket, Key,
    ResponseContentDisposition: `attachment; filename="${fileName}"`, // download (TD-10)
  }),
  { expiresIn: playbackUrlTtlSeconds },
);
```

- `expiresIn` defaults to 900 s. The maximum is 7 days, and expiry is checked on each request (Range requests made after expiry fail).
- `signableHeaders` / `unhoistableHeaders` force headers such as `content-type` or `x-amz-checksum-*` into the signature. Use them only if the upload contract requires the browser to send those headers.
- Payload is `UNSIGNED-PAYLOAD` for presigned URLs. `ResponseContentDisposition` requires a signed request.

## @nestjs/throttler

Used by: `phase-03-videos/TD-13`.

```typescript
@SkipThrottle()
@Controller('videos')
export class VideosController {}
```

- With a **single default (unnamed)** throttler, which is the project's current `{ ttl: 60000, limit: 10 }` `APP_GUARD`, `@SkipThrottle()` with no arguments skips it for the whole controller.
- If named throttlers are ever introduced, `@SkipThrottle()` with no arguments **does not skip them**. Pass `@SkipThrottle({ name: true })` instead.
- `@SkipThrottle({ default: false })` on a route re-enables limiting inside a skipped class.
