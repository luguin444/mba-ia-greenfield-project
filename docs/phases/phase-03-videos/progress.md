# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 15/21 completed

### SI-03.1 — Infra: dependências, namespaces de configuração e variáveis de ambiente
- **Status:** completed
- **Tests:** 23 passing (`src/config/env.validation.integration-spec.ts`: 4 existing + 19 new)
- **Observations:**
  - **Plan deviation (ioredis):** installed `ioredis@^5.11.1` instead of the planned `^6.1.0`. `typeorm@0.3.28` (and the latest typeorm, 1.1.3) declares `ioredis@^5.0.4` as an optional peer, so `npm install` failed with ERESOLVE. `bullmq@6.7.10` accepts `ioredis>=5.0.0`, so 5.11.1 satisfies both without `--legacy-peer-deps` or `overrides` (one deduped copy in the tree). User approved this in the session. `library-refs.md` → `## ioredis` was updated to match.
  - The other libraries were installed at the planned versions: `bullmq@6.7.10`, `@nestjs/bullmq@11.0.5`, `@aws-sdk/client-s3@3.1177.0`, `@aws-sdk/s3-request-presigner@3.1177.0`.
  - The local `.env` (gitignored) was synced by appending only the missing keys from `.env.example`, without printing values. `MAIL_FROM` was also missing from the local `.env` and was added with the example value.
  - context7 shows the newest `@nestjs/config` docs moving Joi options under `validationOptions.libraryOptions`. The project is on `@nestjs/config` 4.x, so the existing `validationOptions` shape stays unchanged.
  - The AC "`GET /` still returns 200" is covered by `test/app.e2e-spec.ts` in the full e2e run at the end of the block. The API server is not started, per `nestjs-project/CLAUDE.md`.

### SI-03.2 — Infra: FFmpeg na imagem dev e serviços redis, minio e minio-init no Compose
- **Status:** completed
- **Tests:** no tests (Infra). Container ACs checked by hand; existing suites green on the new topology: `npm test -- --runInBand` 163/163 (23 suites), `npm run test:e2e -- --runInBand` 52/52 (3 suites)
- **Observations:**
  - MinIO pinned to the multi-arch index digest `cgr.dev/chainguard/minio@sha256:f6243be11aaaa2fe654d260558e2b3fcef50135e78a3abfd0db802b13444f059` (`RELEASE.2026-11-23T00-10-37Z`, resolved 2026-11-25). `minio-init` uses the same digest.
  - The pinned image ships `sh` and `mc` but no curl/wget. Healthcheck: `MC_CONFIG_DIR=/tmp/.mc MC_HOST_self=http://localhost:9000 mc ready self`. It probes the container's own MinIO process; no service-to-service `localhost`. `MC_CONFIG_DIR=/tmp/.mc` because the nonroot user (65532) has no writable default config dir.
  - ACs verified: `redis` and `minio` healthy; `minio-init` exit 0 on the first run and on a forced re-run (`mc mb -p` is idempotent); `ffprobe`/`ffmpeg` 5.1.9 exit 0 in `nestjs-api`; `redis-cli ping` → `PONG`, `maxmemory-policy` = `noeviction`; Node `fetch('http://minio.localhost:9000/minio/health/ready')` from `nestjs-api` → 200; host curl to the same URL → 200; anonymous GET on a `thumbnails` object → 200, on a `videos` object → 403 (probe objects removed afterwards); GET with `Origin` → `Access-Control-Expose-Headers` includes `Etag`.
  - The "no `.env`" AC was checked with `docker compose --env-file /dev/null config`: MinIO credentials fall back to the `.env.example` defaults, and `minio-init` interpolates the same values. A second stack was not started, because its ports would clash with the running one.
  - The host has its own native `redis-server` on `127.0.0.1:6379`. Publishing the container's `6379:6379` still worked, and containers reach Redis via the `redis` service name. From the host, `localhost:6379` may hit the native Redis instead of the container.
  - `redis:8-alpine` is kept as a tag, per the plan. Only the Chainguard images are digest-pinned.

### SI-03.3 — Infra: isolamento do ambiente de teste e `--runInBand` no `test:e2e`
- **Status:** completed
- **Tests:** 2 passing (`src/test/setup-test-env.spec.ts`)
- **Observations:**
  - `jest --showConfig` confirms that both configs resolve `setupFiles` to `dotenv/config` → `/home/node/app/src/test/setup-test-env.ts`, in that order (e2e `rootDir` = `/home/node/app/test`, as the plan states).
  - The re-application test uses `jest.isolateModules` + `jest.requireActual`. A dynamic `import()` fails under ts-jest CommonJS (`nodenext` keeps a native `import()`, which needs `--experimental-vm-modules`), and a raw `require` is blocked by lint.
  - Outside Jest, the container still reads `QUEUE_PREFIX=bull`, `S3_VIDEOS_BUCKET=videos` and `S3_THUMBNAILS_BUCKET=thumbnails` from `.env`. The override exists only in the Jest process.
  - `test/jest-e2e.json` was edited by hand to keep the existing inline array formatting (no cosmetic diff).
  - Out of scope, for the SI-03.21 docs pass: `nestjs-project/CLAUDE.md` → "Test execution" still says to run `npm test -- --runInBand` and that e2e is "already configured". Both scripts now include `--runInBand`.

### SI-03.4 — Entidade `Video`, migration `CreateVideos` e ajustes nos testes existentes
- **Status:** completed
- **Tests:** 9 passing (`src/videos/entities/video.entity.integration-spec.ts` 7 + `src/database/migrations.integration-spec.ts` 2); full `npm test` 172/172 (25 suites)
- **Observations:**
  - Migration `1795641136433-CreateVideos` was generated by the CLI in the container, then reviewed: 2 enum types, FK `channel_id → channels.id` and the 3 indexes (`public_id` unique, `(channel_id, processing_status)`, `(processing_status, updated_at)`). `down` drops all of them. `migration:run` was applied to the dev DB.
  - Extra fallout, beyond the plan's list: the `beforeAll` of `migrations.integration-spec.ts` ran every `DROP TABLE … CASCADE` concurrently in one `Promise.all`. With the new FK chain `videos → channels → users`, that deadlocks (`deadlock detected`, which reproduced on a fully migrated DB). The `afterAll` then fails with `type "verification_tokens_type_enum" already exists`. The drops now run sequentially, and the spec passed twice in a row starting from a fully migrated DB.
  - `id` uses `@PrimaryGeneratedColumn('uuid')`: the DB keeps the `uuid_generate_v4()` default, and the app-generated `randomUUID()` the plan requires is kept on insert (covered by a test).
  - `bigint ↔ number` is a column transformer local to the entity. `failure_reason` is typed as the `VideoFailureReason` enum (the plan's closed set), stored as `varchar(64)`.
  - As the plan's Data Model says, `Channel` has no inverse `@OneToMany`. That diverges from `.claude/rules/nestjs-entities.md` ("both sides"); the plan wins, and `RefreshToken`/`VerificationToken` follow the same one-sided pattern.
  - `Video` was added to `ALL_ENTITIES` in all 10 existing specs. Prettier reflowed only the touched lines.

### SI-03.5 — Módulo de storage (adapter S3 com client interno e público)
- **Status:** completed
- **Tests:** 12 passing (`src/storage/storage.module.spec.ts` 1 + `src/storage/storage.service.integration-spec.ts` 11, real MinIO, `-test` buckets)
- **Observations:**
  - Two `S3Client` providers (`S3_INTERNAL_CLIENT` → `S3_ENDPOINT`, `S3_PUBLIC_CLIENT` → `S3_PUBLIC_ENDPOINT`), both with `forcePathStyle: true` and `requestChecksumCalculation: 'WHEN_REQUIRED'`. The test asserts that part URLs carry no `x-amz-checksum*`. `StorageService.onModuleDestroy` calls `destroy()` on both clients, so no HTTP sockets are left open.
  - `headObject` returns `null` for both `NotFound` and `NoSuchKey`. `abortMultipartUpload` tolerates only `NoSuchUpload`, and MinIO returns that name when the same `uploadId` is aborted twice. Every other S3 error propagates.
  - AC "the same URL is valid from inside `nestjs-api` and from the host": checked by hand. A GET presigned by the public client with `Range: bytes=0-99` returned `206` / 100 bytes from Node `fetch` in the container and from `curl` on the host. The probe object and script were removed.
  - Note for SI-03.8/03.14: `createMultipartUpload(key)` follows the plan's signature, which sends no `ContentType`. The source object is stored with MinIO's default type, and the presigned GET for playback returns that type, not `video/*`. If the browser player needs it, pass `mime_type` at initiate (a decision for the leader; not changed here).

### SI-03.6 — Módulo de fila (BullMQ) compartilhado entre API e worker
- **Status:** completed
- **Tests:** 5 passing (`src/queue/queue.module.integration-spec.ts`, real Redis). With `QueueModule` in `AppModule`: full e2e `npm run test:e2e` 52/52 (3 suites) and full `npm test` 189/189 (28 suites), with no "did not exit"/open-handle warning; `tsc --noEmit` 0
- **Observations:**
  - bullmq 6 API: `Queue.client` is `undefined` at runtime. The raw Redis client now lives on the backend (`queue.getBackend().client`, typed `IRedisClient`, which has no `exists`). The AC test reads the job hash with `hget('<prefix>:video-processing:<jobId>', 'name')`: `process-video` under `test:` and `null` under `bull:`. Relevant if a later SI needs the raw client (the sweep in SI-03.19 only uses `getJob`, which stays the same).
  - `obliterateTestQueues(moduleRef)` throws if a queue's prefix is not `TEST_ENV_OVERRIDES.QUEUE_PREFIX` (`test`), so it can never wipe the containers' `bull:*` queues. It obliterates (`force: true`) and closes the two queues. Workers (from SI-03.16 on) are closed by Nest's own shutdown when the caller closes the module/app.
  - Existing e2e suites need no change: every one already calls `app.close()`, and `@nestjs/bullmq` closes the queues in `onApplicationShutdown`. They never enqueue, so they do not need `obliterateTestQueues`. After the runs, Redis had no `test:*` keys and no `bull:video-processing:*` keys.
  - `BullModule.forRootAsync` has no `imports: [ConfigModule]`. It relies on the global `ConfigModule` (`AppModule`, and later `WorkerModule`), per `.claude/rules/nestjs-testing.md`.

### SI-03.7 — Fundações do domínio de vídeos (exceções, `publicId`, resposta e lookup de canal)
- **Status:** completed
- **Tests:** 32 passing (`public-id.util.spec.ts` 7, `video-response.mapper.spec.ts` 4, `videos.exceptions.spec.ts` 11, `videos.module.spec.ts` 1, `channels.service.integration-spec.ts` 9 = 4 existing + 5 new). End of block W4.2: full `npm test` 218/218 (32 suites), full `npm run test:e2e` 52/52 (3 suites, covers "the API starts with `VideosModule` and `GET /` → 200"), `tsc --noEmit` 0, `npm run lint` 0
- **Observations:**
  - Extra test file, not in the plan's table: `src/videos/videos.exceptions.spec.ts`. It runs each of the 9 exceptions through the real `DomainExceptionFilter` and checks `{ statusCode, error, message }` literally against the Error Catalog. It is the observable test for the AC "each video exception is rendered as …". `UploadIncompleteException(missing)` builds the message `Upload is missing parts: 1, 2, …` with at most 20 numbers, then `, …` (the rule SI-03.10 cites), so the format lives in the exception.
  - `ChannelsService.findIdByUserId` / `lockIdByUserId` select only `id`. The lock uses `lock: { mode: 'pessimistic_write' }` (`FOR UPDATE`). The test proves that a second connection gets `55P03` with `FOR UPDATE NOWAIT` while the transaction is open and gets the lock after commit, and that outside a transaction TypeORM throws `PessimisticLockTransactionRequiredError`.
  - `VideoResponseDto` has explicit `@ApiProperty` on all 19 fields: it is a response DTO, so the Swagger plugin has no validator to infer from (`.claude/rules/nestjs-dtos.md`). Nullable fields declare `type` + `nullable: true`.
  - `videos.module.spec.ts` keeps the plan's name and the existing `*.module.spec.ts` pattern (e.g. `channels.module.spec.ts`), even though it opens Postgres + Redis. That diverges from the suffix rule in `nestjs-project/CLAUDE.md` (DB I/O ⇒ `*.integration-spec.ts`); the inconsistency predates this phase.
  - Every suite that loads `AppModule`/`VideosModule` leaves only the `test:video-processing:meta` and `test:video-maintenance:meta` hashes in Redis (written by `Queue` on connect; bullmq version, no jobs). Under the `test` prefix they never touch `bull:*`.

### SI-03.8 — Endpoint POST /videos/uploads
- **Status:** completed
- **Tests:** 30 passing for the SI: `src/videos/videos.service.spec.ts` 17, `src/videos/videos.service.integration-spec.ts` 4, `test/videos-uploads.e2e-spec.ts` 8 (the 8 spec scenarios), `src/videos/videos.module.spec.ts` 1. Fallout re-run: `src/storage/storage.service.integration-spec.ts` 11/11
- **Observations:**
  - `StorageService.createMultipartUpload(key, contentType)` now sends `ContentType`, as the leader's plan fix asked. The 4 calls in `storage.service.integration-spec.ts` pass `'video/mp4'`.
  - The `public_id` retry uses one SAVEPOINT per attempt (`video_public_id_N`), max 5, and retries only on `23505` whose `detail` names `(public_id)`. The unique-violation check is a local copy of the private helper in `ChannelsService`. Follow-up for the separate task the plan already names (the `ChannelsService` retry without SAVEPOINT): move the helper to a shared place and use it in both modules.
  - When the insert fails, the multipart upload is aborted best-effort. If the abort also fails, it is logged at `warn` and the insert error is rethrown. The abort is only attempted for an insert failure, as the plan says. A commit failure after a successful insert would leave an orphan multipart upload (a rare edge case, not covered).
  - `VideosModule` now registers `VideosController` + `VideosService`. `videos.module.spec.ts` loads `videoConfig` (needed by the service) and also checks `VideosService`.
  - New e2e helper `test/support/videos-e2e.ts`, shared by the 5 video e2e suites of this block: app bootstrap with the `main.ts` globals, register → confirm → login (captures the token through the mail spy, like `auth.e2e-spec.ts`), expired token via `jwtService.sign(payload, { expiresIn: -60 })`, initiate, and a direct PUT to storage. Not in the plan's table, but it keeps the 5 suites from repeating ~80 lines each.
  - The e2e suites leave aborted/open multipart uploads in `videos-test` (no row survives `cleanAllTables`). The integration suite aborts the uploads it opened in `afterEach`. The leftovers are bounded and test-only. Cleaning `videos-test` belongs to whoever adds a bucket lifecycle (out of scope).
  - The `pg` warning "Calling client.query() when the client is already executing a query" predates this SI: `channels.service.integration-spec.ts` and `videos.module.spec.ts` print it too. It comes from TypeORM `synchronize` in the test DataSource.

### SI-03.9 — Endpoint POST /videos/:id/upload/part-urls
- **Status:** completed
- **Tests:** 19 new, passing for the SI: `src/videos/videos.service.spec.ts` +9 (26 total), `src/videos/videos.service.integration-spec.ts` +3 (7 total), `test/videos-upload-part-urls.e2e-spec.ts` 7 (the 7 spec scenarios). `test/videos-uploads.e2e-spec.ts` re-run: 8/8
- **Observations:**
  - `findOwnedOrFail` loads the video and the caller's channel id (`ChannelsService.findIdByUserId`) in parallel. A missing video, another channel's video, and a caller without a channel all give the same `VideoNotFoundException`. `assertUploading` is a TS assertion function (`asserts video is UploadingVideo`), so `upload_id` is narrowed to `string` in later code. It also rejects `uploading` with a `null` `upload_id`, which the state machine never produces.
  - `INVALID_PART_NUMBER` is checked before `ListParts` (pure input check, no I/O). The plan lists the steps in the other order, but the response is the same. Explicit `partNumbers` are signed in ascending order.
  - `updated_at` is touched with `update({ id, processing_status: 'uploading' }, { updated_at: () => 'CURRENT_TIMESTAMP' })`. It uses the DB clock, like the column default, so no app/DB clock skew. It runs after the presign, so a failed presign does not count as activity.

### SI-03.10 — Endpoint POST /videos/:id/upload/complete
- **Status:** completed
- **Tests:** 25 new, passing for the SI: `src/videos/videos.service.spec.ts` +11 (37 total), `src/videos/videos.service.integration-spec.ts` +3 (10 total), `test/videos-upload-complete.e2e-spec.ts` 7 (the 7 spec scenarios), `src/storage/storage.service.integration-spec.ts` +1 (13 total). Re-run: `src/videos` + `src/storage` 91/91, uploads + part-urls + complete e2e 22/22
- **Observations:**
  - **Storage extensions:** `headObject` now returns `{ contentLength, contentType }`. The integration test checks `ContentType = mime_type` (`video/webm` → `video/webm`), and the SI-03.5 assertion was updated. `completeMultipartUpload` maps S3 `NoSuchUpload` to a new storage error, `MultipartUploadNotFoundError` (`src/storage/storage.errors.ts`). The videos service maps that error to `InvalidVideoStateException`, so the domain never inspects S3 SDK error names. A new storage integration test proves the mapping against MinIO (complete after abort).
  - **Plan wording, no behavior change:** API Contracts step 4 says to "re-read the row" after `NoSuchUpload`, but both outcomes (row no longer `uploading`, or still `uploading`) answer `INVALID_VIDEO_STATE`. The re-read would not change the response, so it was not implemented. The SI's Technical action 2 ("em NoSuchUpload, lança InvalidVideoStateException") is followed as written. The unit test covers `NoSuchUpload` → 409 with no update and no enqueue. Since there is no re-read, "row already out of `uploading`" and "row still `uploading`" are the same code path.
  - Per-part size check before `CompleteMultipartUpload`: parts `1..partCount-1` must be exactly `partSize`, and the last part must be `size_bytes − (partCount − 1) × partSize`. Any other size → `422`, and the row stays `uploading`. Parts listed above `partCount` (the API never signs them) are left out of the complete call.
  - HeadObject backstop: if the object is missing, has the wrong size, or is over the max → `deleteObject`, a conditional update to `failed`/`UPLOAD_SIZE_MISMATCH`/`upload_id = null`, then `422`.
  - Enqueue: `Promise.race` between `queue.add(...)` and a 3 s timer (`ENQUEUE_TIMEOUT_MS` in `videos.constants.ts`). The timer is cleared in `finally`. `Promise.race` subscribes to `add`, so a late rejection is not left unhandled. The `catch` calls `logger.error` (message with `videoId`, plus the stack) and has a comment citing the plan section. The e2e "Redis not answering" case answers `202` in ~3.1 s.
  - The spec's integration test "sweep re-enqueues the orphaned row" belongs to SI-03.19 (maintenance sweep), not this SI.
  - `toResponse(video)` (`toVideoResponse` + `thumbnailUrl` via `publicObjectUrl` when `thumbnail_key` is set) was added here, because the `202` body is a `VideoResponse`. SI-03.12 reuses it and owns its unit test.

### SI-03.11 — Endpoint DELETE /videos/:id/upload
- **Status:** completed
- **Tests:** 7 new, passing for the SI: `src/videos/videos.service.integration-spec.ts` +2 (12 total), `test/videos-upload-abort.e2e-spec.ts` 5 (the 5 spec scenarios). Re-run: `src/videos` 80/80
- **Observations:**
  - The `failed`/`UPLOAD_ABORTED`/`upload_id = null` transition is a conditional update (`WHERE id AND processing_status = 'uploading'`). 0 affected rows → `INVALID_VIDEO_STATE`, the same guard as `complete`. The plan does not spell this out for abort. It covers a concurrent `complete` that commits between the check and the update. In that case the multipart upload is already completed, the abort is tolerated (`NoSuchUpload`), and the video stays `processing`.
  - After the abort, MinIO answers the PUT to the old part URL with `404` and an XML body containing `NoSuchUpload`. The e2e asserts both. The integration test checks that `listAllParts` of the aborted upload rejects with `name: 'NoSuchUpload'`. That is the raw S3 error; only `completeMultipartUpload` maps it to a storage error.

### SI-03.12 — Endpoint GET /videos/:id
- **Status:** completed
- **Tests:** 9 new, passing for the SI: `src/videos/videos.service.spec.ts` +4 (41 total), `test/videos-detail.e2e-spec.ts` 5 (the 5 spec scenarios)
- **Observations:**
  - `getOwned` = `findOwnedOrFail` + the `toResponse` added in SI-03.10. There is no state check: the owner sees any `processing_status`. The unit tests here cover `toResponse`'s `thumbnailUrl` branch: `publicObjectUrl(thumbnailsBucket, thumbnail_key)` when `thumbnail_key` is set, otherwise `null` with no storage call.
  - The e2e thumbnail scenario writes a 4-byte JPEG frame to `thumbnails-test` with `StorageService.putObject` (`ContentType: image/jpeg`). An anonymous `fetch` of `thumbnailUrl` returns `200` + `image/jpeg`, with no `X-Amz-*` in the URL. The object is deleted in a `finally`.
  - The e2e checks that the body has no `uploadId`/`upload_id`/`sourceKey`/`source_key`/`channelId`/`channel_id`. The mapper never copies them, so this guards against a future regression.

### SI-03.13 — Guard de autenticação opcional (`@OptionalAuth`)
- **Status:** completed
- **Tests:** 10 passing in `src/auth/guards/jwt-auth.guard.spec.ts` (5 existing + 5 new). `test/auth.e2e-spec.ts` re-run in full: 45/45
- **Observations:**
  - The guard's unit test now mocks `Reflector.getAllAndOverride` per metadata key. The old mock returned the same value for any key, so with the new optional-auth lookup the `@Public()` test would have run the optional branch. The `@Public()` test now also proves the header is never read (the `headers` getter is a spy that must not be called).
  - Optional-auth branches covered: no header → anonymous; non-`Bearer` header (e.g. `Basic …`) → anonymous, as the Authorization Matrix says ("no `Authorization` header (or not `Bearer `)"); valid token → `request.user` = payload; expired token (`jwtService.sign(payload, { expiresIn: -60 })`) → `401` with `request.user` untouched; invalid token → `401`.
  - `@OptionalAuth()` has no route yet in this SI. The HTTP-level ACs (anonymous, valid token via `@CurrentUser()`, expired token → `401`) are proven by the playback e2e in SI-03.14.
  - `CurrentUser` is unchanged (it still declares `JwtPayload`). Optional-auth handlers type the parameter `JwtPayload | undefined`, as the plan says.
  - **Pre-SI hygiene (leader request, outside the SIs, commit `test(videos): clean test buckets after video suites`):** the video suites left `videos-test` dirty (180 open multipart uploads and 148 MiB in 22 objects before this block). New helper `resetVideoTestBuckets(moduleRef)` in `src/test/storage.ts` uses the module's real internal S3 client and config. It aborts every open multipart upload (`ListMultipartUploads` paged by `KeyMarker`/`UploadIdMarker`; the SDK has no paginator for it) and deletes every object (`paginateListObjectsV2` + one `DeleteObject` per key, because `DeleteObjects` sends the SDK's default CRC checksum, which S3-compatible stores do not all accept) in `videos-test` and `thumbnails-test`. It throws before any S3 call if either bucket name does not end in `-test` (unit test `src/test/storage.spec.ts`, 2 cases). It runs in the `afterAll` of `storage.service.integration-spec.ts`, `videos.service.integration-spec.ts` and every video e2e suite (through `closeVideosE2eApp`), before the module is closed. MinIO answers `ListMultipartUploads` with no prefix (all 180 listed), so no per-key listing was needed. After the storage + videos integration suites and the 5 video e2e suites: `mc ls --incomplete --recursive local/videos-test` → 0, `mc du` → 0 objects in both buckets.

### SI-03.14 — Endpoint GET /videos/:publicId/playback
- **Status:** completed
- **Tests:** 17 new, passing for the SI: `src/videos/videos.service.spec.ts` +10 (51 total), `src/videos/videos.service.integration-spec.ts` +1 (13 total), `test/videos-playback.e2e-spec.ts` 6 (the 6 spec scenarios). Re-run: full `npm run test:e2e` 90/90 (9 suites, includes `auth.e2e-spec.ts` and the other video suites after the shared helper change)
- **Observations:**
  - `resolveViewable` is `private`. Its unit tests (the plan's 5 cases plus a missing `publicId`, non-owner on a non-ready draft, and a ready non-draft for an anonymous caller) go through `getPlaybackUrl`, which calls it first. SI-03.15 reuses it from `getDownloadUrl` in the same service.
  - The channel lookup runs only for a draft with a caller. An anonymous caller and a non-draft video never query `channels`. The "non-draft is visible to anyone" branch has a unit test with a forged `'published'` value, because Phase 03's enum only has `draft`. It keeps the Phase 04 gate covered.
  - Shared e2e helpers `uploadAndComplete(app, token, fileName, sizeBytes)` (initiate a single-part upload → PUT → `complete` → `202`) and `markVideoReady(dataSource, videoId)` (simulates the worker: `ready` + `processed_at`) added to `test/support/videos-e2e.ts`. The playback and download specs both describe this setup ("helper do arquivo"), so it lives in the shared support file instead of being copied into both suites.
  - The integration test builds the ready video through the real `initiateUpload` → PUT → `completeUpload` path and then sets `ready` on the row. It checks host `minio.localhost:9000`, path `/videos-test/{id}/source`, `206`, `Content-Range: bytes 0-1023/1048576` and a 1024-byte body.
  - `@ApiBearerAuth('access-token')` on this `@OptionalAuth()` route follows the plan's Authorization Matrix ("optional-auth operations declare `@ApiBearerAuth`"). It overrides the general rule in `.claude/rules/nestjs-controllers.md` that `@Public()` methods must not carry it; that rule predates optional auth. Follow-up for SI-03.21 or the rule's owner: add the optional-auth exception to the rule.
  - `publicId` has no validation pipe on purpose. A malformed value must answer `404 VIDEO_NOT_FOUND` like a missing one (never `400`), so the pattern check is in the service and skips the DB.

### SI-03.15 — Endpoint GET /videos/:publicId/download
- **Status:** completed
- **Tests:** 13 new, passing for the SI: `src/videos/content-disposition.util.spec.ts` 5, `src/videos/videos.service.spec.ts` +2 (53 total), `src/videos/videos.service.integration-spec.ts` +1 (14 total), `test/videos-download.e2e-spec.ts` 5 (the 5 spec scenarios). End of block W4.4: full `npm test -- --runInBand` 298/298 (36 suites), full `npm run test:e2e` 95/95 (10 suites), `tsc --noEmit` 0, `npm run lint` 0, `mc ls --incomplete --recursive local/videos-test` → 0 (and 0 objects in `videos-test` / `thumbnails-test`)
- **Observations:**
  - `buildAttachmentDisposition`: the ASCII `filename` drops accents (NFKD + strip combining marks) and turns every other character outside printable ASCII, plus `"` and `\`, into `_`. The regex uses the `u` flag, so an emoji (a surrogate pair) becomes one `_`, not two. `filename*` is `encodeURIComponent` plus `'`, `(`, `)`, `*` percent-encoded, because RFC 5987 `attr-char` does not allow them. Control characters (CR/LF/TAB) are `_` in `filename` and percent-encoded in `filename*`, so the header cannot be split.
  - The integration test proves MinIO answers the presigned GET with the exact header (`attachment; filename="Ferias em Sao Paulo.mp4"; filename*=UTF-8''F%C3%A9rias%20em%20S%C3%A3o%20Paulo.mp4`) and the full 1 MiB body. The e2e checks the emoji name: printable-ASCII `filename` ending in `.mp4`, and `filename*` decodes back to `Férias em São Paulo 🎬.mp4`.
  - `getDownloadUrl` and `getPlaybackUrl` share `resolveViewable` and a private `signSourceGet(video, disposition?)`. The only difference is the disposition.
  - `VIDEO_NOT_READY` keeps the catalog message "Video is not ready for playback" on the download route too, as the download spec expects. The Error Catalog has a single message for both routes.
  - `@ApiBearerAuth` on this optional-auth route: same note as SI-03.14 (the plan overrides the general `@Public()` rule in `nestjs-controllers.md`).
  - **Leader follow-up (W4.4 gate, committed at the start of W4.5 as `test(videos): tighten playback/download assertions and e2e teardown`):** the download e2e happy path now compares `Content-Disposition` by full equality (as `videos.service.integration-spec.ts` already did); the playback e2e 409 for an `uploading` video uses `toEqual` on the whole body (same as the `processing` case); `closeVideosE2eApp` wraps the queue/bucket cleanup in `try/finally` so `app.close()` runs even if the cleanup throws. `videos-download` + `videos-playback` e2e: 11/11.

### SI-03.16 — Infra: `WorkerModule`, entrypoint `src/worker.ts` e serviço `video-worker`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.17 — Ferramentas de mídia: wrapper `ffprobe`/`ffmpeg` e fixtures
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.18 — Consumer `process-video` (metadados e thumbnail)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.19 — Varredura de manutenção (`video-maintenance`)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.20 — E2E do pipeline completo (upload → processamento → streaming/download)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.21 — Documentação: `CLAUDE.md` (raiz e `nestjs-project`) e `openapi.json`
- **Status:** pending
- **Tests:** —
- **Observations:** none
