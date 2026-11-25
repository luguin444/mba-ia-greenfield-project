# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 8/21 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Endpoint POST /videos/:id/upload/complete
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Endpoint DELETE /videos/:id/upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Endpoint GET /videos/:id
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Guard de autenticação opcional (`@OptionalAuth`)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Endpoint GET /videos/:publicId/playback
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Endpoint GET /videos/:publicId/download
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
