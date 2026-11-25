# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/21 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Fundações do domínio de vídeos (exceções, `publicId`, resposta e lookup de canal)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Endpoint POST /videos/uploads
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
