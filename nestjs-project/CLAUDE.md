# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, queue, storage) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

**Exception: `video-worker`.** The queue consumer is a Compose service with `restart: unless-stopped`, so `docker compose up -d` starts it together with the infrastructure. That is expected. It is not the HTTP server, and it never binds a port.

After starting the environment, always confirm the containers are up before proceeding:

```bash
docker compose ps   # db, mailpit, redis, minio, nestjs-api and video-worker "running"; minio-init "exited (0)"
```

Then verify each service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose ps minio` shows `(healthy)` (its healthcheck runs `mc ready`). From the host, `curl http://localhost:9000/minio/health/ready` → `200`. From inside a container, **never curl a `*.localhost` host** (curl pins it to the container's own loopback); use Node: `docker compose exec nestjs-api node -e "fetch('http://minio.localhost:9000/minio/health/ready').then(r => console.log(r.status))"` → `200`
- **video-worker:** `docker compose logs video-worker` shows `Consuming "video-processing"` and `Consuming "video-maintenance"`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development. First-time setup, in this order:

```bash
cp .env.example .env                                   # Compose and dotenv both read it
docker compose up -d                                   # infra + nestjs-api + video-worker
docker compose exec nestjs-api npm install             # node_modules live in the bind mount
docker compose exec nestjs-api npm run migration:run   # schema, including the videos table
docker compose restart video-worker                    # it booted before node_modules/.env/migrations existed
```

On a fresh clone the `video-worker` starts before `node_modules` and the schema exist, so it crash-loops until the restart above. Run the dev server only when asked: `docker compose exec nestjs-api npm run start:dev`.

**After changing `Dockerfile.dev`** (e.g., the FFmpeg install), rebuild before `up`: `docker compose build`. `nestjs-api` and `video-worker` share that image, so `up -d` alone keeps running the old image.

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — queue consumer (`npm run start:worker` → `src/worker.ts`), same image, code and `.env` as the API, no port. See "Video Worker" below
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture for confirmation/reset emails: SMTP `1025`, web UI `http://localhost:8025`
- `redis` — Redis 8 for BullMQ, `--maxmemory-policy noeviction` (BullMQ requires it). **No host port:** only the containers use it (`REDIS_HOST=redis`)
- `minio` — S3-compatible storage: API `9000`, console `http://localhost:9001` (credentials `S3_ACCESS_KEY`/`S3_SECRET_KEY`). Network alias `minio.localhost` (see the root `CLAUDE.md`, "Docker Networking")
- `minio-init` — one-shot bucket bootstrap: creates `videos`, `thumbnails`, `videos-test`, `thumbnails-test` and makes both thumbnail buckets public-read. It exits with code 0, which is expected

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running, only when the dev server was started (expect 200 + "Hello World!")
curl http://localhost:3000

# Readiness probes
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl http://localhost:9000/minio/health/ready

# Check container logs
docker compose logs nestjs-api
docker compose logs -f video-worker
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run start:worker                     # Video worker (the video-worker service already runs it)
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm run migration:run                    # Apply pending migrations
npm run openapi:export                   # Regenerate openapi.json (commit the diff)

npm test                                 # Unit + integration tests (script already has --runInBand)
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (script already has --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs -f video-worker
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl http://localhost:3000
curl http://localhost:9000/minio/health/ready
```

### Test execution

Integration and e2e suites share a single test database, so they run serially. Both scripts already include `--runInBand`; no extra flag is needed:

```bash
docker compose exec nestjs-api npm test           # jest --runInBand (unit + integration)
docker compose exec nestjs-api npm run test:e2e   # jest --config ./test/jest-e2e.json --runInBand
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

**Isolation from the running containers** comes from `src/test/setup-test-env.ts`, a Jest `setupFiles` entry in both configs (loaded right after `dotenv/config`). Before any module compiles, it force-assigns `QUEUE_PREFIX=test`, the buckets `videos-test`/`thumbnails-test` and smaller upload limits (12 MiB max, 5 MiB parts). Tests and the `video-worker` container (prefix `bull`, buckets `videos`/`thumbnails`) therefore never consume each other's jobs or objects. Suites that touch queues or storage clean up in `afterAll` with `obliterateTestQueues` (`src/test/queues.ts`) and `resetVideoTestBuckets` (`src/test/storage.ts`). Both helpers refuse to run outside the `test` prefix or the `-test` buckets.

`test/videos-pipeline.e2e-spec.ts` boots the HTTP app **and** the `WorkerModule` in the same Jest process (helper `test/helpers/video-pipeline.ts`). It runs a real upload → FFmpeg processing → playback/download cycle on the test prefix and buckets.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config", "<rootDir>/test/setup-test-env.ts"]` (unit/integration, `rootDir` is `src`) and `["dotenv/config", "<rootDir>/../src/test/setup-test-env.ts"]` (`test/jest-e2e.json`) — without `dotenv/config`, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS. Without `setup-test-env.ts`, tests would share the queue prefix and buckets with the containers (see "Test execution").
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Two entrypoints share the code: `src/main.ts` (HTTP API, `AppModule`) and `src/worker.ts` (video worker, `WorkerModule`, no HTTP listener)

## Video Worker

- **Entrypoint:** `src/worker.ts` → `NestFactory.createApplicationContext(WorkerModule)` with shutdown hooks. Script `npm run start:worker` (`exec ts-node …`, so node receives the signals). `src/worker/worker.module.ts` imports config, TypeORM, `QueueModule` and `StorageModule`, and registers only the consumers: no controllers, `AuthModule` or throttler.
- **Consumers** (`src/videos/processing/`): `VideoProcessingConsumer` (queue `video-processing`, job `process-video`, `jobId = videoId`, 3 attempts with exponential backoff) runs ffprobe/ffmpeg through `MediaToolsService`, writes the metadata and the thumbnail and marks the video `ready`/`failed`. `VideoMaintenanceConsumer` (queue `video-maintenance`) runs the sweep: uploads idle longer than `VIDEO_UPLOAD_STALE_AFTER_MS` → `failed`/`UPLOAD_ABANDONED` + multipart aborted; `processing` rows with no job → re-enqueued; failed job → `PROCESSING_ERROR`. `VideoMaintenanceScheduler` upserts the Job Scheduler `video-maintenance-sweep` (`every: VIDEO_SWEEP_INTERVAL_MS`) at boot. The upsert is idempotent, so restarts and replicas keep a single scheduler.
- **Logs:** `docker compose logs -f video-worker`. A healthy boot shows `Video worker started (redis redis:6379, queue prefix "bull")`, `Consuming "video-processing"` and `Consuming "video-maintenance"`. Each sweep logs `Sweep done: …`.
- **Apply code changes:** the worker has no watch mode, so run `docker compose restart video-worker`.
- **Stopping is noisy but clean:** `docker compose stop video-worker` prints `npm error signal SIGTERM` (plus `npm error command failed`), and the container exits with code `1`. **This is expected.** Node receives SIGTERM, the shutdown hooks run first (BullMQ workers and the DB pool close; the log line `Video worker stopped (SIGTERM)` is the evidence), and only then npm reports its child's signal as an error.

## Vídeos

Module `src/videos/` (`VideosModule`): `videos.controller.ts`, `videos.service.ts`, `entities/video.entity.ts`, `dto/`, `video-response.mapper.ts`, `public-id.util.ts` (11-character `publicId`), `content-disposition.util.ts`, `videos.exceptions.ts`. Shared infrastructure: `src/storage/` (`StorageService`, S3 adapter with an internal client for `S3_ENDPOINT` and a public one that signs URLs for `S3_PUBLIC_ENDPOINT`) and `src/queue/` (`QueueModule`, BullMQ queues `video-processing` and `video-maintenance` with prefix `QUEUE_PREFIX`). Worker code is in `src/videos/processing/`.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/videos/uploads` | JWT | Pre-registers the video (draft) and opens the multipart upload; returns `videoId`, `publicId`, `partSize`, `partCount` and the first batch of presigned part URLs |
| `POST` | `/videos/:id/upload/part-urls` | JWT (owner) | Lists the parts already stored and signs the missing (or requested) ones, used to resume an upload |
| `POST` | `/videos/:id/upload/complete` | JWT (owner) | Completes the multipart upload, sets `processing` and enqueues `process-video` (`202`) |
| `DELETE` | `/videos/:id/upload` | JWT (owner) | Aborts an upload in progress (`204`, video `failed`/`UPLOAD_ABORTED`) |
| `GET` | `/videos/:id` | JWT (owner) | Video status and metadata (`processingStatus`, `failureReason`, duration, dimensions, codecs, `thumbnailUrl`) |
| `GET` | `/videos/:publicId/playback` | Optional (`@OptionalAuth()`) | Presigned GET for streaming with HTTP Range (`206`) straight from storage |
| `GET` | `/videos/:publicId/download` | Optional (`@OptionalAuth()`) | Presigned GET with `Content-Disposition: attachment` |

All video routes skip the throttler (`@SkipThrottle()`). Optional-auth routes still declare `@ApiBearerAuth('access-token')` in OpenAPI. A draft is visible only to its owner, and anyone else gets the same `404 VIDEO_NOT_FOUND` as for a missing video.

**Flow:** the client calls `POST /videos/uploads`, PUTs each part straight to MinIO/S3 through the presigned URLs (video bytes never pass through the API) and, if interrupted, resumes with `part-urls`. It then calls `complete`. The API commits `processing` and enqueues `process-video` with `jobId = videoId`. The `video-worker` probes the file, stores the thumbnail and sets `ready` (or `failed` with `INVALID_MEDIA`/`PROCESSING_ERROR`). The client polls `GET /videos/:id` and plays or downloads through the presigned URLs.

**Buckets and keys:** source `S3_VIDEOS_BUCKET` (`videos`, private) → `{videoId}/source`. Thumbnail `S3_THUMBNAILS_BUCKET` (`thumbnails`, public-read) → `{videoId}/default.jpg`, served by an unsigned public URL. Tests use `videos-test`/`thumbnails-test`.

**Status mapping** (`processing_status` + `publication_status`; the video stays `draft` on the publication axis through Phase 03):

| Challenge cycle | Columns |
|---|---|
| rascunho | `publication_status = 'draft'` + `processing_status = 'uploading'` |
| processando | `processing_status = 'processing'` |
| pronto | `processing_status = 'ready'` |
| erro | `processing_status = 'failed'` + `failure_reason` (`UPLOAD_ABANDONED`, `UPLOAD_ABORTED`, `UPLOAD_SIZE_MISMATCH`, `INVALID_MEDIA`, `PROCESSING_ERROR`) |

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
