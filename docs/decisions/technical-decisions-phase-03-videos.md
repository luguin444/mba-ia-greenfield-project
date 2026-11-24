---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-11-24
scope_description: "Phase 03 — video upload (up to 10GB, direct to object storage), background processing (queue + FFmpeg worker extracting duration/metadata and a thumbnail), unique short video URL, streaming playback (HTTP Range/206) and download. Covers the queue technology, worker runtime, upload protocol, storage layout/provisioning, delivery path, status lifecycle, rate-limit interaction and test infrastructure."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — owns every server-side piece of this phase: the `videos` domain (draft pre-registration, upload orchestration, unique ID, status), the S3 client and presigned-URL issuance, the queue producer, and the video worker (FFmpeg/ffprobe), plus the Compose services it needs (object storage, queue broker, worker). TD-01 … TD-16.
- `next-frontend/` — no screen in Phase 03's bullets (upload/playback screens land in Phases 04/05; the leader handles the UI-detection false positive as "deferred" in plan-context). Its contracts are still fixed here, by the Cross-layer TDs it will later consume through the BFF: TD-05 (upload handshake, browser → storage PUTs), TD-09 (public video ID in URLs) and TD-10 (playback/download URL delivery). No Frontend-only TD.

**Constraints carried in from the current code (weighed in every TD):**

- Global `ThrottlerGuard` with `{ ttl: 60000, limit: 10 }` registered as `APP_GUARD` (`nestjs-project/src/auth/auth.module.ts:29,35`). `APP_GUARD` is global regardless of the module that declares it, so **every** route, video routes included, gets 10 req/min per tracker. Default tracker is `req.ip`; no `trust proxy` and no `X-Forwarded-For` forwarding exist in the BFF (`next-frontend/lib/api/upstream.ts`), so behind the strict BFF **all browser users share the Next.js container's IP bucket**. See TD-13.
- Global `JwtAuthGuard` (`auth.module.ts:34`): anonymous routes need `@Public()` (`src/auth/decorators/public.decorator.ts`).
- No async infrastructure exists (no broker, no worker, no storage service in `nestjs-project/compose.yaml`).
- `nestjs-project/Dockerfile.dev` is `node:25.6.0-slim` = **Debian 12 bookworm** (verified with `/etc/os-release`), installs only `procps curl`, so there is no ffmpeg. The apt candidate is `ffmpeg 7:5.1.9-0+deb12u1`, verified with `apt-cache policy`.
- Architecture tension: `docs/diagrams/software-arch.mermaid` says `Rel(frontend, storage, "Streams")`. `next-frontend/CLAUDE.md` says "strict BFF: the browser never talks to the NestJS API directly", and `next-frontend-config-base/TD-03` (decided A) already anticipated that "object storage URLs will need a separate mechanism anyway (presigned URLs from object storage, NOT the backend URL)". Resolved by TD-10 (and TD-05 for uploads).
- Error envelope `{ statusCode, error, message }` with domain codes (`phase-02-auth/TD-07`, decided A). New video errors follow it. Responses served **by the object storage** (presigned PUT/GET) do not follow it; see TD-05/TD-10.
- All entity PKs are `@PrimaryGeneratedColumn('uuid')`.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The diagram leaves the queue as "TBD". The queue carries "process video X" jobs from the API to the worker. It needs retries with backoff, deduplication (one job per video) and visibility of failed jobs. Nothing async exists yet, so this choice also adds (or avoids) a new Compose service.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq`)
- Redis-backed job queue with first-class Nest integration (`BullModule.forRoot/registerQueue`, `@Processor` + `WorkerHost`). Built-in `attempts` + `backoff: { type: 'exponential' }`, custom `jobId` deduplication, failed-job retention and manual `job.retry()`.
- **Pros:** Official Nest technique doc (`techniques/queues`). Retry/backoff/dedup are configuration, not code. `@nestjs/bullmq@12.0.2` peers `@nestjs/core ^11` and `bullmq ^6`. Redis is a lightweight container (`redis:8-alpine` → Redis 8.12.0, verified) and can later back other concerns (e.g. throttler storage).
- **Cons:** New infrastructure service. Redis **must** run with `maxmemory-policy noeviction` or BullMQ breaks. Enqueue is not transactional with the Postgres write (dual write), which needs a reconciliation sweep (TD-12). Dedup by `jobId` stops working once the job is removed (`removeOnComplete/Fail`).

### Option B: pg-boss (Postgres-backed queue)
- Job queue stored in the existing PostgreSQL (`SKIP LOCKED`). Jobs can be enqueued **inside the same DB transaction** as the video row (`send(..., { db })` adapters), plus retry/backoff and singleton keys.
- **Pros:** Zero new infrastructure: reuses `db`. Transactional enqueue removes the dual-write problem (draft/status + job commit together). `pg-boss@12.39.0` requires Node `>=22.12` (container runs Node 25).
- **Cons:** No official Nest module, so the producer/consumer wiring is hand-written. Documented transaction adapters target Knex/Kysely/Drizzle/Prisma, and a TypeORM `QueryRunner` adapter would need a custom `executeSql` bridge (not documented for TypeORM). Puts queue polling load on the primary DB. Contradicts the diagram's separate "Message Queue" container (a doc update would be needed).

### Option C: RabbitMQ (AMQP)
- Dedicated message broker. Nest supports it via the microservices transport, or a community wrapper. Retries need dead-letter exchanges/TTL plumbing.
- **Pros:** True broker semantics, routing, very mature. Language-agnostic consumers.
- **Cons:** Heaviest option: broker container + management, and retry/backoff and dedup are hand-built (DLX + TTL), not built in. Nothing in Phase 03 needs routing or fan-out.

**Recommendation:** **Option A (BullMQ + Redis)**. It is the only option where retries, exponential backoff, `jobId` dedup and failed-job inspection come from the official Nest integration without custom plumbing, and it matches the diagram's separate queue container. The real cost is the non-transactional enqueue: it is covered by an idempotent `jobId = videoId` plus a periodic reconciliation (TD-12). pg-boss (B) is the honest runner-up if the team prefers zero new infrastructure and transactional enqueue over Nest-native ergonomics.

**Decision:** _[pending]_

---

## TD-02: Video Worker Runtime & Container Topology

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The diagram has a separate "Video Worker (FFmpeg)" container. FFmpeg work is CPU/IO heavy and must not compete with HTTP handling ("sem impacto na performance"). The worker needs the `Video` entity, the TypeORM config, the S3 client and ffmpeg/ffprobe binaries. `Dockerfile.dev` has none of the binaries. Integration/e2e tests run today **inside `nestjs-api`** (`docker compose exec nestjs-api npm test` / `npm run test:e2e`, per `nestjs-project/CLAUDE.md` and the DoD), and the services share a bind-mounted `node_modules`. So *where ffmpeg lives* decides *where ffmpeg-dependent tests can run*, and this TD settles both. Depends on TD-01.

**Options:**

### Option A: Same codebase, separate entrypoint/container, one shared dev image with ffmpeg
- `nestjs-project` gains a second bootstrap (`NestFactory.createApplicationContext(WorkerModule)`, no HTTP listener) that registers the `@Processor`. `Dockerfile.dev` adds `ffmpeg` (apt, bookworm 5.1.9), and **both** `nestjs-api` and a new `video-worker` Compose service build from it, differing only by `command` (the worker service runs the worker entrypoint; `nestjs-api` keeps `tail -f /dev/null` + `exec`).
- **Pros:** Matches the diagram and isolates worker CPU at the **process/container** level. Tests keep running in `nestjs-api` with real ffprobe/ffmpeg available, so **no DoD command changes**. Reuses entities, `registerAs` configs, Joi validation and the S3 module, all in one `package.json` and one lint/test/tsc pipeline. One image to build and cache.
- **Cons:** The API dev image carries ffmpeg it does not use at runtime (≈ image size only). Image isolation is deferred: a lean, separate production image per process belongs to the deploy work (Phase 07). `WorkerModule` must not import HTTP-only modules.

### Option B: Same codebase, separate entrypoint/container, ffmpeg only in a worker image
- Same as A, but the worker builds from its own Dockerfile/stage with ffmpeg, and `nestjs-api` stays ffmpeg-free.
- **Pros:** Image-level isolation already in dev; the API image is unchanged.
- **Cons:** ffmpeg-dependent integration tests can only run in the worker container, so the **DoD changes**: the full suite must run (also) via `docker compose exec video-worker npm test` (or the whole suite moves there), splitting the "full suite passes" gate across two containers. Two images to keep in sync for the same `node_modules`.

### Option C: Worker inside the API process
- Register the BullMQ processor in the API's `AppModule`. Same container, which then needs ffmpeg in `Dockerfile.dev`.
- **Pros:** Simplest: no new service, no second bootstrap.
- **Cons:** FFmpeg/ffprobe and S3 reads run in the API container and contend with request handling, which goes against "sem impacto na performance". API and worker cannot scale independently. Contradicts the diagram.

### Option D: Separate subproject (`video-worker/`)
- A new top-level subproject (Node or another language) with its own manifest, compose and tests, sharing only DB/queue/storage.
- **Pros:** Strongest isolation, so a different language/runtime is possible.
- **Cons:** Duplicates the `Video` entity/schema knowledge, config validation and S3 client in a second stack, which risks drift on the status contract. A new subproject means new lint/test/CI pipelines (monorepo tooling cost) for one job type.

**Recommendation:** **Option A (same codebase, separate `video-worker` container, one shared dev image with ffmpeg)**. Process-level isolation is what "sem impacto na performance" needs at runtime, and sharing the dev image keeps every test, including real ffprobe/ffmpeg integration and e2e, in `nestjs-api`. **DoD commands stay exactly as they are** (`docker compose exec nestjs-api npm test`, `… npm run test:e2e`, `… npx tsc --noEmit`, `… npm run lint`). What changes is the precondition: the image must be rebuilt once (`docker compose build`), and `minio` + `redis` must be up and ready before the suites (TD-14). B splits the DoD gate across two containers for an image-size gain that only matters in production, C puts FFmpeg next to the HTTP server, and D pays a monorepo-tooling cost Phase 03 does not need.

**Decision:** _[pending]_

---

## TD-03: Metadata & Thumbnail Extraction Tooling (FFmpeg/ffprobe)

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Duration/codec/resolution come from `ffprobe` (JSON output via `-print_format json -show_format -show_streams`). The thumbnail comes from `ffmpeg` grabbing one frame. The usual Node wrapper, `fluent-ffmpeg`, is **deprecated on npm ("Package no longer supported", 2.1.3) and its GitHub repo is archived**, so it is excluded. What remains is how the binaries are invoked and provisioned. Depends on TD-02.

**Options:**

### Option A: System binaries (apt) + thin typed `execFile` wrapper
- Worker image installs `ffmpeg` from Debian (provides `ffprobe` too). A small service calls `child_process.execFile('ffprobe', [...args])` (no shell) and parses JSON into a typed DTO. Thumbnail: `ffmpeg -ss <t> -i <input> -frames:v 1 <out.jpg>`.
- **Pros:** No third-party wrapper to go stale. `execFile` with an args array avoids shell injection. The binary version is pinned by the base image (5.1.9) and works on arm64/amd64 alike. Easy to unit-test (mock `execFile`) and integration-test (real binary).
- **Cons:** The binary version follows Debian's cadence (5.1.x, not latest 7.x). Requires writing ~1 small parser for ffprobe's JSON.

### Option B: npm-bundled static binaries (`ffmpeg-static` / `ffprobe-static`) + `execFile`
- Binaries come from npm packages (downloaded at install), and the code is the same as A.
- **Pros:** No Dockerfile change; versions pinned in `package-lock.json`.
- **Cons:** `ffprobe-static@3.1.0` was last published in 2022 and `ffmpeg-static@5.3.0` downloads binaries at install time (network/arch fragility in containers). Large binaries go into the bind-mounted `node_modules` on the host and get reinstalled per architecture.

**Recommendation:** **Option A (system ffmpeg via apt + `execFile` wrapper)**. The Debian package gives a reproducible, arch-independent ffmpeg/ffprobe in the shared dev image (TD-02 A), so the same binary serves the worker at runtime and the tests in `nestjs-api`, and a thin `execFile` wrapper replaces the deprecated `fluent-ffmpeg` without adopting another wrapper. Thumbnail frame policy (e.g. a fixed fraction of duration, clamped to the first seconds for short clips) is a parameter of this TD, not a separate decision.

**Decision:** _[pending]_

---

## TD-04: How the Worker Reads the Source Video

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The source can be 10GB. ffprobe reads only the container header/index, and the thumbnail needs one frame. Downloading the whole object to the worker's disk costs 10GB of I/O and temp space per job. FFmpeg's `http` protocol auto-detects seekability (`seekable=-1`) and issues Range requests, and object storage serves Range on presigned GETs. Depends on TD-02/TD-03/TD-07.

**Options:**

### Option A: ffprobe/ffmpeg read a short-lived presigned GET URL directly
- The worker presigns a GET for the source key (internal endpoint) and passes the URL as `-i`. FFmpeg seeks via HTTP Range, so only the header/index and the bytes around the chosen frame are transferred.
- **Pros:** Constant disk usage regardless of file size. Fast for well-formed files. No shared volume between containers.
- **Cons:** For files with the MP4 index (`moov`) at the end, ffprobe seeks to the tail (still Range, but 2+ round trips). Network errors mid-read surface as ffmpeg failures, which need retry (TD-12). The presign expiry must outlive the job.

### Option B: Download the full object to a worker temp volume, then process locally
- `GetObject` streamed to a temp file, ffprobe/ffmpeg on the local path, temp deleted after.
- **Pros:** Simplest mental model; ffmpeg works on any file layout without network concerns.
- **Cons:** 10GB disk + 10GB transfer per job just to read a header and one frame. The worker needs temp space ≥ max upload size (TD-06), and concurrency multiplies it.

**Recommendation:** **Option A (presigned GET + FFmpeg HTTP Range reads)**. The phase needs only metadata and one frame, so streaming the whole 10GB through the worker's disk is the dominant cost Option B adds for no product gain. Option B stays a valid fallback for a future transcoding phase, where the full read is unavoidable.

**Decision:** _[pending]_

---

## TD-05: Upload Protocol for up to 10GB Without Passing Through the API

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** 10GB cannot go through the API or the BFF without tying up their processes ("sem impacto na performance"). A single S3 PUT, plain or presigned, is capped at **5GB**, so multipart is mandatory. Pontos de Atenção require resuming after a connection failure. The handshake spans browser ↔ BFF ↔ API ↔ storage, so this is one cross-layer contract. The "draft on upload start" bullet means the `Video` row is created at the upload's *initiate* step. Depends on TD-07 (bucket/endpoint), TD-06 (limits), TD-13 (throttling).

**Options:**

### Option A: S3 Multipart Upload with presigned part URLs, orchestrated by the API
- `POST /videos/uploads` (JWT) validates the declared size/type, creates the **draft `Video`** and calls `CreateMultipartUpload`, then returns `videoId`, `uploadId`, `partSize` and presigned `UploadPart` URLs (batched). The browser PUTs parts **directly to storage** and keeps `{PartNumber, ETag}`. `POST /videos/:id/upload/complete` makes the API call `CompleteMultipartUpload` (parts sorted ascending), verify size (`HeadObject`) and enqueue processing (TD-01). Resume: the client keeps `videoId`, and the API's `ListParts` tells which parts are done before it re-signs the missing ones. Abort: `AbortMultipartUpload`.
- **Pros:** Zero video bytes through API/BFF. Native to S3/MinIO, with no extra server. Resumable at part granularity. Every step is an explicit API call, so the draft-on-initiate and enqueue-on-complete hooks are deterministic and testable. Limits: parts 1–10,000, 5 MiB–5 GiB each, last part exempt from the minimum (AWS; MinIO documents the same 5 MiB/10,000).
- **Cons:** The bucket CORS must **expose `ETag`** or browsers cannot read it (AWS SDK docs). The presigner signs with `UNSIGNED-PAYLOAD`, so part integrity relies on the final size check (and optional checksums). Errors from storage PUTs are S3 XML, not the `{statusCode,error,message}` envelope, so the client handles two error shapes. Orphan multipart uploads need cleanup (TD-12). The client must implement part slicing/retry (a library such as Uppy's S3 plugin is an implementation detail).

### Option B: tus protocol via a `tusd` sidecar with S3 backend
- A `tusd` container speaks tus (resumable by protocol: `HEAD` offset, `PATCH` chunks) and writes to S3 via multipart internally. Hooks (`pre-create`, `post-finish`) call the API to create the draft and enqueue processing.
- **Pros:** Standard resumable protocol with mature clients (tus-js-client/Uppy). Byte-level resume (not part-level). Bytes still bypass the API.
- **Cons:** Another service in the upload data path: every byte goes through tusd, which needs local temp disk to buffer to the 5 MiB minimum part. The hook HTTP contract between tusd and the API is a new integration surface, and auth must be forwarded to tusd. On the browser side, a third origin (tusd) joins the BFF and storage.

**Recommendation:** **Option A (S3 multipart with presigned part URLs, API-orchestrated)**. It is the only option where no service other than the object store touches video bytes, and resumability comes from `ListParts`. The draft-on-initiate and enqueue-on-complete hooks are plain API endpoints that follow the existing JWT/envelope conventions. tus (B) buys finer-grained resume at the price of an extra data-path service and a hook contract. Note on the strict-BFF rule: the browser talks to **storage** (presigned URLs), never to the Nest API, which is the carve-out `next-frontend-config-base/TD-03` already anticipated.

**Decision:** _[pending]_

---

## TD-06: Upload Size Limits & Part Sizing (configurable, testable)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** "Até 10GB" is a policy that must be enforced. A presigned part URL cannot cap how many bytes a client sends, so the authoritative check is after completion. The limit and part size are cited by the Joi env schema, Compose env, the API response (client slices by `partSize`) and the tests. Tests cannot move 10GB, but S3 requires ≥5 MiB per non-final part, so a real multipart test needs ≥2 parts of ≥5 MiB. Depends on TD-05.

**Options:**

### Option A: Env-configured limits, server-dictated part size computed per upload
- `VIDEO_MAX_UPLOAD_BYTES` (default 10 GiB) and `VIDEO_UPLOAD_PART_SIZE_BYTES` (default e.g. 64 MiB, min 5 MiB) are validated by Joi. On initiate, the API rejects declared sizes over the max and returns `partSize = max(configured, ceil(size / 10000))`. On complete, `HeadObject` checks the real size, and oversize leads to delete + domain error.
- **Pros:** Tests set e.g. max = 12 MiB and part = 5 MiB, which exercises real multi-part, the over-limit rejection and the post-complete size check with tiny files. Production keeps 10 GiB with no code path difference. The server owns part math, so a client cannot exceed 10,000 parts.
- **Cons:** Two more env keys in schema + compose + `.env.example`. The post-complete check means an oversize upload is detected after bytes are stored (then deleted).

### Option B: Hard-coded constants, test override via DI provider
- Limits live in a constants file and tests override the provider.
- **Pros:** No env surface.
- **Cons:** e2e tests boot the real app and the worker container cannot be DI-overridden from a test, so it diverges from the Phase 01 convention (`registerAs` + Joi) used for every other tunable.

**Recommendation:** **Option A (env-configured, server-dictated part size)**. It follows the Phase 01 config convention and is the mechanism that makes "10GB" testable without 10GB: the same code path runs with a 12 MiB ceiling and 5 MiB parts in tests.

**Decision:** _[pending]_

---

## TD-07: Object Storage Layout — Buckets, Keys and Presigning Endpoint

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** S3/MinIO is given. What is open is how objects are organised and exposed. Videos must stay private (unlisted videos in Phase 05). Thumbnails will appear in listings (Phase 07 grid). Presigned URLs embed the host in the SigV4 signature, so a URL signed for `http://minio:9000` (Compose service name, per CLAUDE.md Docker networking) is unusable from the browser. Two endpoints are needed: internal for server-side calls and public for presigning. With MinIO, `forcePathStyle: true` is required. Pontos de Atenção ask to plan storage growth/cost from the start.

**Options:**

### Option A: One private bucket, prefixes per asset type
- `streamtube` bucket: `videos/{videoId}/source`, `thumbnails/{videoId}/default.jpg`. Every read is presigned.
- **Pros:** One bucket, one CORS/lifecycle config.
- **Cons:** Listing pages (Phase 07) must presign one URL per thumbnail per render, which means uncacheable, ever-changing URLs and signing cost on every list request.

### Option B: Two buckets: private `videos` + public-read `thumbnails`
- `videos` (private, presigned only): `{videoId}/source`. `thumbnails` (anonymous read): `{videoId}/{variant}.jpg`. Keys use the opaque `videoId`, never the user's filename or user ID.
- **Pros:** Thumbnails get stable, cacheable URLs with no signing, ready for Phase 07 grids and Phase 04 custom thumbnails. Videos stay private. Separate lifecycle/cost policy per bucket (e.g. abort-incomplete-multipart only on `videos`). Unguessable key = no enumeration.
- **Cons:** Two buckets to provision. Thumbnails of unlisted videos are publicly fetchable if someone has the URL (same exposure model as "unlisted").

### Option C: Owner-scoped keys (`users/{userId}/videos/{videoId}/...`)
- Keys are namespaced by owner in a single private bucket.
- **Pros:** Easy per-user usage accounting by prefix.
- **Cons:** Leaks the owner ID into object URLs. Ownership changes would mean object moves. Same per-thumbnail signing cost as A.

**Recommendation:** **Option B (private `videos` + public-read `thumbnails`, keys by `videoId`)**, with two S3 endpoints in config: `S3_ENDPOINT` (internal, Compose service name, for SDK calls and the worker's own presigned reads in TD-04) and `S3_PUBLIC_ENDPOINT` (the host embedded in browser-facing presigned URLs and public thumbnail URLs). The value of `S3_PUBLIC_ENDPOINT`, which must be reachable from both the browser/host and the tests inside `nestjs-api`, is decided in TD-16. It keeps the 10GB originals private while giving listing pages stable thumbnail URLs, and it lets cost controls (incomplete-upload cleanup, future quotas) target only the bucket that grows. Phase 03 stores only the original + one thumbnail per video, so there are no derivative copies (see TD-11).

**Decision:** _[pending]_

---

## TD-08: Local S3-Compatible Storage Provisioning (MinIO distribution)

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The stack names "S3 or MinIO", and MinIO is the natural local/dev and test target. Since Oct 2025 the MinIO community edition is **source-only**: the `minio/minio` README says "THIS REPOSITORY IS NO LONGER MAINTAINED" and "We will no longer provide pre-compiled binary releases". On 2026-11-24, `docker manifest inspect` failed for `minio/minio:latest`, pinned `minio/minio:RELEASE.2025-*` tags, `quay.io/minio/minio` and `bitnami/minio`, while `redis:8-alpine` resolved fine. `cgr.dev/chainguard/minio:latest` resolves (`RELEASE.2026-11-23T00-10-37Z`, AGPLv3), and so does `cgr.dev/chainguard/minio-client`. The choice is cross-component (compose + bucket bootstrap + tests).

**Options:**

### Option A: Chainguard-built MinIO image, pinned by digest
- `cgr.dev/chainguard/minio` (built from MinIO source by Chainguard) + `cgr.dev/chainguard/minio-client` for the bucket/CORS/anonymous-policy bootstrap, both pinned by `@sha256:` digest in compose.
- **Pros:** Works today with no build step. Same S3 API surface the code targets. Digest pinning gives reproducibility.
- **Cons:** Depends on a third-party rebuild of an unmaintained upstream. The free tier is effectively `latest`, so upgrades mean moving the digest deliberately.

### Option B: Build MinIO from source in-repo
- A small Dockerfile does `go install github.com/minio/minio@<tag>` (the README's official path).
- **Pros:** No third-party image dependency; full control of the version.
- **Cons:** Adds a Go build stage to the dev environment (slow first build, toolchain upkeep) for a component the project does not develop.

### Option C: Another S3-compatible server for dev/test (e.g. SeaweedFS, Garage)
- Keep the S3 contract and run a different maintained S3-compatible server locally.
- **Pros:** Actively maintained upstreams.
- **Cons:** Diverges from the documented "S3 or MinIO". Compatibility of presigned multipart, CORS `ExposeHeader: ETag` and bucket policies would have to be re-verified per server. No research here was done to the depth required to recommend one.

**Recommendation:** **Option A (Chainguard MinIO, digest-pinned)**. It is the only option verified to run today that keeps the documented MinIO target, with no build tooling. The application code talks plain S3 (`@aws-sdk/client-s3`, `forcePathStyle`), so moving to B, C or real S3 later is a compose change, not a code change.

**Decision:** _[pending]_

---

## TD-09: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Pontos de Atenção ask for a **short** URL that **never** conflicts. Phase 05 requires unlisted videos to be reachable only by direct link, so the ID must be **unguessable** (no enumeration). The ID appears in API routes and frontend routes, so it is one cross-layer contract. Entity PKs today are UUIDs.

**Options:**

### Option A: Expose the UUID PK
- `/watch/3f1c…-…` (36 chars).
- **Pros:** No new column or generator; uniqueness by construction.
- **Cons:** Not short (36 chars), which fails the "URL curta" attention point. Exposes the internal PK.

### Option B: Random short public ID in its own unique column (base64url, 11 chars from 64 random bits)
- `publicId = randomBytes(8).toString('base64url')` (Node `crypto`, no dependency), `UNIQUE` index, retry on unique violation. The PK stays a UUID.
- **Pros:** Short (11 chars, YouTube-like), unguessable (2^64 space), so unlisted links are safe. "Never conflicts" is guaranteed by the DB constraint, with retry as the backstop. Decoupled from the PK. No dependency (`nanoid@6` is ESM-only; it would work through Node's `require(esm)` on Node 25, but is unnecessary).
- **Cons:** An extra column + index. Retry-on-collision code path (astronomically rare, but must exist and be tested).

### Option C: Sqids/Hashids encoding of a sequential integer
- Encode an auto-increment ID into a short string.
- **Pros:** Very short; no collision handling.
- **Cons:** Reversible/enumerable by design (sequence leaks volume, and neighbours are discoverable), which breaks unlisted privacy (Phase 05). Needs a sequential integer key the schema does not have.

**Recommendation:** **Option B (random 11-char base64url `publicId` with UNIQUE constraint)**. It is the only option that is short **and** unguessable, both of which are required (short by the attention point, unguessable by Phase 05 unlisted). The "never conflicts" guarantee comes from the DB constraint, not from probability alone.

**Decision:** _[pending]_

---

## TD-10: Playback (Range/206) and Download Delivery Path

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback without a full download is HTTP Range → `206 Partial Content`, issued repeatedly by the `<video>` element while seeking. Anonymous users must be able to watch (`@Public()` under the global `JwtAuthGuard`). This TD settles the diagram ("Frontend streams from Object Storage") vs README/CLAUDE.md ("strict BFF") tension. The global 10 req/min throttler (shared BFF IP, see TD-13) makes any path that sends Range requests through Nest unworkable. S3 checks presigned-URL expiry **when each request arrives**: an in-flight download completes, but a new Range request after expiry fails.

**Options:**

### Option A: Presigned GET direct from storage; API issues short-lived URLs
- `GET /videos/:publicId/playback` (`@Public`, through the BFF) returns `{ url, expiresAt }` for a presigned `GetObject`. The browser's `<video>` fetches Range/206 **directly from storage**. Download: the same endpoint family returns a presigned URL with `ResponseContentDisposition: attachment; filename=…` (an S3 response override that requires a signed URL).
- **Pros:** Storage serves Range/206 natively, so zero video bytes go through API/BFF and the throttler sees one call per view. Strict BFF holds for the **API** (the browser never learns the Nest URL), and the storage carve-out is the one `next-frontend-config-base/TD-03` anticipated. The diagram's "Streams from Object Storage" becomes literally true. Download reuses the same mechanism.
- **Cons:** The expiry must exceed a viewing session (max 7 days for SigV4), or the player needs a URL refresh on 403. The frontend CSP `media-src` must allow the storage public host. Storage errors are S3 XML, not the API envelope.

### Option B: Proxy through API (and BFF) with Range passthrough
- `GET /videos/:publicId/stream` forwards `Range` to `GetObject` and pipes a `StreamableFile` with 206 headers. The BFF route proxies again.
- **Pros:** One origin for the browser; URLs never expire; full control over auth per request.
- **Cons:** Every Range request (dozens per view) hits Nest **and** the BFF, which is incompatible with the global 10 req/min throttler keyed on the shared BFF IP. Two Node processes stream every byte, against "sem impacto na performance". Requires `@Public` streaming plus throttle exemptions.

### Option C: Public-read video bucket with stable URLs
- Videos are anonymously readable, and the API returns a plain URL.
- **Pros:** Simplest; cacheable; never expires.
- **Cons:** Anyone with a key can fetch any video, which defeats future unlisted/draft privacy (Phase 04/05), since drafts would be publicly readable once the key leaks.

**Recommendation:** **Option A (presigned GET direct from storage, URL issued by a `@Public` API endpoint via the BFF)**. It is the only option where Range/206 traffic never touches the throttled, BFF-shared API path while drafts and unlisted videos stay private. It resolves the diagram/BFF tension cleanly: strict BFF governs the **API**, and media bytes come from storage via short-lived signed URLs. Which statuses may be played (e.g. only `ready`) is enforced by the issuing endpoint (TD-12).

**Decision:** _[pending]_

---

## TD-11: Playback Format (original file vs derived rendition)

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** Range playback starts fast only if the MP4 index (`moov`) is at the start. FFmpeg's docs note that `moov` is written at the end by default and that `-movflags +faststart` moves it to the front "for better playback". Browsers also play only certain codecs. Phase 03's processing bullet asks only for duration/metadata, and transcoding is not in scope. Storage cost (Pontos de Atenção) grows with every derived copy. Depends on TD-04/TD-07.

**Options:**

### Option A: Serve the original upload as-is (progressive Range playback)
- No re-encode. ffprobe metadata is stored (codec, container) so later phases can flag non-browser-playable sources.
- **Pros:** Zero extra CPU/storage. Download = exactly what was uploaded. Matches the phase's processing scope.
- **Cons:** `moov`-at-end files need an extra Range seek before playback starts. Codecs browsers don't support (e.g. some `.mov`/HEVC/AVI) won't play.

### Option B: Remux to MP4 with `-movflags +faststart` (stream copy, no re-encode)
- The worker writes a faststart copy (`-c copy`) and playback uses it.
- **Pros:** Fast start for every MP4-compatible source; cheap CPU (no re-encode).
- **Cons:** Reads + writes the full file (up to 10GB of I/O), which conflicts with TD-04 A. Doubles storage unless the original is dropped. Still doesn't fix unsupported codecs.

### Option C: Transcode to H.264/AAC MP4 faststart (or HLS ladder)
- A universal rendition (optionally adaptive HLS).
- **Pros:** Plays everywhere; adaptive bitrate with HLS.
- **Cons:** Heavy CPU (hours for long 10GB sources on dev hardware) and extra storage per rendition. HLS adds a player library to the frontend. Well beyond the phase's "extração de duração e metadados".

**Recommendation:** **Option A (serve the original, progressive Range)** for Phase 03. It meets "reprodução sem download completo" with zero added CPU/storage, and the phase scope is metadata, not transcoding. What is lost: guaranteed fast-start and codec universality. Option B is the cheapest upgrade if fast-start becomes a product requirement, and C belongs to a dedicated future phase.

**Decision:** _[pending]_

---

## TD-12: Video Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** A video is created as a draft on initiate (TD-05), then goes through upload completion, processing and success or failure. "Rascunho" is a **publication** concept (Phase 04 adds draft→published and public/unlisted), while uploading/processing/ready/failed is a **technical** lifecycle. Failure modes: abandoned uploads (never completed; orphan multipart parts cost storage), enqueue lost after the DB write (non-transactional, TD-01 A), transient ffmpeg/network errors (TD-04), and permanently invalid files (not a video). Depends on TD-01/TD-05.

**Options:**

### Option A: Single combined status enum
- One `status`: `draft_uploading → processing → ready | failed`, later also `published`.
- **Pros:** One column; simple queries.
- **Cons:** Conflates two axes: in Phase 04 a `ready` video is still a draft until published, and a published video could be re-processed. Combinations explode as Phase 04 adds visibility.

### Option B: Two orthogonal fields: `processingStatus` + publication state
- `processingStatus`: `uploading → processing → ready | failed` (+ `failureReason`). Publication: `draft` (the only value in Phase 03; Phase 04 adds `published` and visibility). Failure policy: BullMQ `attempts` + exponential backoff for transient errors. An unrecoverable probe (not a video) goes straight to `failed`, with no retry. The worker is idempotent (`jobId = videoId`; re-running overwrites metadata/thumbnail). A periodic sweep marks stale `uploading` videos `failed` and `AbortMultipartUpload`s them, and re-enqueues `processing` rows whose job is missing.
- **Pros:** Each phase owns its axis (Phase 04 doesn't touch the processing machine). Playback/listing rules read naturally (`ready` AND published). Covers every failure mode, including the dual write.
- **Cons:** Two columns + a sweep job (scheduler) to build and test.

### Option C: Status column + `video_processing_attempts` history table
- Option B plus a row per processing attempt (start/end/error).
- **Pros:** Full audit trail for debugging.
- **Cons:** Another entity + migration with no capability in Phases 03–07 that reads it. BullMQ already retains failed-job data.

**Recommendation:** **Option B (orthogonal `processingStatus` + publication, retries with backoff, idempotent worker, stale-upload/reconciliation sweep)**. Keeping the technical lifecycle separate from "rascunho" lets Phase 04 add publication/visibility without reshaping this machine. The sweep is what makes the non-transactional enqueue (TD-01 A) and abandoned 10GB multipart uploads safe, and the latter is a direct storage-cost control (Pontos de Atenção). MinIO's server-side stale-upload expiry (`api stale_uploads_expiry`, default 24h per MinIO docs) and S3's `AbortIncompleteMultipartUpload` lifecycle rule are backstops, not substitutes, because neither updates the DB row.

**Sweep scheduling mechanism (part of Option B):**

- **Chosen: BullMQ Job Scheduler, running in the worker process.** On worker bootstrap, the worker calls `queue.upsertJobScheduler('video-maintenance-sweep', { every: <ms> }, { name: 'sweep' })` on a dedicated `video-maintenance` queue, and a `@Processor('video-maintenance')` in `WorkerModule` executes it. `upsert` is idempotent by scheduler ID, so restarts or extra worker replicas re-declare the same scheduler instead of stacking duplicates, and each tick becomes one job processed by one worker. The interval and the stale threshold are env-configured (TD-06 pattern: e.g. `VIDEO_SWEEP_INTERVAL_MS`, `VIDEO_UPLOAD_STALE_AFTER_MS`). Tests invoke the processor directly instead of waiting for a tick. Library: `bullmq` (same dependency as TD-01; latest `6.7.10`, docs read at v6.5.3). In v6 the legacy repeatable-job API (`add(..., { repeat })`, `getRepeatableJobs`, `removeRepeatable*`) is **removed** in favour of Job Schedulers, so the scheduler API is the only supported path.
- **Why the worker, not the API:** the sweep calls `AbortMultipartUpload`/`ListParts` on storage and writes status. Keeping it beside the processing processor keeps the API request-path-only and puts all background mutations of `processingStatus` in one process.
- **Considered alternative: `@nestjs/schedule` `@Cron`** (`@nestjs/schedule@12.0.4`, peers `@nestjs/core ^11||^12`). The cron is registered in-process at `onApplicationBootstrap` (Nest docs, `techniques/task-scheduling`), so every process that imports `ScheduleModule` runs its own timer, and multiple worker replicas would sweep concurrently unless a lock is added. It is also one more dependency for something the queue already provides. Rejected.
- **Dependency:** valid if TD-01 = A. If TD-01 = B (pg-boss), this mechanism must be re-researched against pg-boss's own scheduling.

**Decision:** _[pending]_

---

## TD-13: Rate-Limit Policy for Video Endpoints

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** `ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }])` + global `ThrottlerGuard` (`auth.module.ts:29,35`) apply to every route. `phase-02-auth/TD-08` intended auth-only scoping, but `APP_GUARD` is global. The default tracker is `req.ip`, and the BFF does not forward the client IP, so **every browser user shares one 10 req/min bucket** (the Next server's IP). Even with TD-05 A/TD-10 A, an upload needs ≥3 API calls (initiate, sign batches, complete) plus status polling, and every anonymous view needs one playback-URL call, so site-wide traffic would be capped at ~10 views/min. Fixing the tracker (trust proxy + forwarded client IP) is a cross-cutting auth/BFF change **out of this phase's scope**. It is recorded below as a separate task.

**Options:**

### Option A: `@SkipThrottle()` on the videos controllers
- Video routes opt out of the default throttler. Upload routes stay JWT-protected, and playback routes are `@Public` reads.
- **Pros:** Removes the shared-bucket bottleneck for the whole phase with one decorator. No change to Phase 02 auth limits. Reversible once the tracker is fixed.
- **Cons:** No abuse limit on the anonymous playback-URL endpoint until a per-client tracker exists.

### Option B: Named throttlers with a generous `videos` policy
- Add a named policy (e.g. 600/min) applied to video controllers and skip the default there (`@SkipThrottle({ default: true })` + `@Throttle({ videos: … })`). Per the throttler docs, named policies apply to every route unless skipped.
- **Pros:** Keeps some ceiling on video routes.
- **Cons:** With the shared BFF IP, the ceiling is still site-wide, not per user, so it is an arbitrary global cap that can still throttle legitimate traffic. Named throttlers apply globally unless skipped, which touches auth routes' configuration too.

### Option C: Keep the global 10/min and minimise call counts
- Batch all part signatures in the initiate response and avoid polling.
- **Pros:** No throttler change.
- **Cons:** Anonymous playback is still capped site-wide at ~10 views/min, so the capability fails under normal use.

**Recommendation:** **Option A (`@SkipThrottle()` on video controllers)**, combined with TD-05/TD-10's design that keeps per-upload/per-view API calls O(1). Under the current shared-IP tracker, any IP-based limit on video routes is a site-wide limit, so B and C cap legitimate traffic. **Accepted residual risk:** with A, the authenticated `POST /videos/uploads` has no rate limit, so one account could open unlimited drafts + multipart uploads (DB rows and orphan parts). The mitigation accepted for this phase is a per-channel cap on videos in `processingStatus = uploading` (env-configured, domain error in the `{statusCode,error,message}` envelope when exceeded), plus TD-12's sweep, which fails and aborts stale uploads. **Separate task (out of scope):** make the throttler track the real client (BFF forwards client IP, API trusts the proxy / custom `getTracker`). After that, a per-client `videos` policy (B) becomes meaningful.

**Decision:** _[pending]_

---

## TD-14: Test Infrastructure for Storage, Queue and Worker

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The project's convention (`nestjs-project/CLAUDE.md`) is that integration/e2e tests use **real** infrastructure from the same Compose stack (shared Postgres, `--runInBand`) and never mock the DB. Phase 03 adds storage, queue and worker, and the brief asks for them to be real in integration/e2e. Tests run inside `nestjs-api`, which gets ffmpeg through the shared dev image (TD-02 A). Presigned URLs used by tests must be reachable from inside that container with a valid signature (TD-16). Test videos must exist without committing large binaries. Per `nestjs-project/CLAUDE.md`, "starting the environment" starts only infrastructure, never the app, so e2e should not depend on a long-running worker container being up.

**Options:**

### Option A: Real MinIO + Redis services in the existing Compose; test-scoped buckets/queue; generated fixtures; worker booted in-process
- Tests talk to the Compose `minio`/`redis` services with dedicated test buckets and a test queue prefix, cleaned per suite. Fixtures are generated at setup with `ffmpeg -f lavfi -i testsrc…` (seconds-long MP4) plus random bytes for the "not a video" case. "10GB" is proven through TD-06 config (tiny max, 5 MiB parts, 2–3 part uploads). Integration tests call the processor class against real MinIO + ffprobe. e2e boots the HTTP app **and** `WorkerModule` (`createApplicationContext`) in the same Jest process, PUTs parts to the presigned URLs (TD-16), completes, and polls until `ready`.
- **Pros:** Same pattern as the existing DB tests, so no new tooling. Exercises real S3 multipart, presigned signatures and real ffprobe. **DoD commands unchanged** (everything runs in `nestjs-api`). No dependency on the `video-worker` container being started. Tiny generated fixtures keep the repo light.
- **Cons:** e2e with an async processor needs a polling helper with a timeout. Shared services keep `--runInBand`. `nestjs-project/CLAUDE.md` startup verification must gain MinIO/Redis readiness probes (doc change at implementation time).

### Option B: Testcontainers (ephemeral MinIO/Redis per suite)
- Each suite starts its own containers from the test process.
- **Pros:** Full isolation; parallel-safe.
- **Cons:** Tests run **inside** the `nestjs-api` container, so Testcontainers would need the Docker socket mounted (Docker-in-Docker). Diverges from the established shared-Compose pattern. Random container ports would also break the fixed-host/port presigning contract (TD-16).

### Option C: Mocked S3/queue in integration tests (e.g. `aws-sdk-client-mock`), real only in e2e
- Integration tests stub the SDK and queue, and only e2e touches real services.
- **Pros:** Fast, no extra services for most tests.
- **Cons:** Mocks cannot catch the failures that matter here (part-size minimums, ETag/ordering on complete, presign host mismatch, ffprobe parsing of real output). Contradicts the brief's "fila, worker e storage reais" and the project's no-mock integration convention.

**Recommendation:** **Option A (real MinIO + Redis in Compose, test-scoped buckets/queue, ffmpeg-generated fixtures, limits shrunk via TD-06, `WorkerModule` booted in-process for e2e)**. It extends the existing shared-Compose test model instead of introducing Docker-in-Docker, it is the only option that exercises the S3/FFmpeg behaviours most likely to break, and it keeps every DoD command running unchanged in `nestjs-api`.

**Decision:** _[pending]_

---

## TD-15: Video Ownership Anchor (channel vs user)

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The draft row needs an owner foreign key at creation. Each user has exactly one channel today (Phase 02: "Criação automática do canal"). Downstream phases are channel-centric: Phase 04 "Painel de gerenciamento de vídeos do canal" and "Página pública do canal com … listagem de vídeos", and Phase 05 shows the channel on the watch page. The JWT carries the user, so the API resolves the channel.

**Options:**

### Option A: `Video.channelId` (video belongs to the channel)
- FK to `channels`. The upload endpoint resolves the caller's channel from the JWT user.
- **Pros:** Matches every downstream read (channel panel, channel page, watch page) with no extra join. Ownership checks compare `video.channel.userId` with the JWT user.
- **Cons:** Every write resolves user → channel first (one lookup).

### Option B: `Video.userId` (video belongs to the user)
- FK to `users`; the channel is derived via the user.
- **Pros:** Ownership check is a direct compare with the JWT `sub`.
- **Cons:** Every channel-centric read (Phases 04–07) joins through users. It also bakes in the 1:1 user↔channel assumption.

**Recommendation:** **Option A (`channelId`)**. The product's ownership unit is the channel (panel, public page, watch page), and anchoring there keeps Phases 04–07 reads direct. The extra user→channel lookup happens only on writes.

**Decision:** _[pending]_

---

## TD-16: Presigned URL Host Reachability (browser/host ↔ Compose network)

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** SigV4 signs the `host` (including port) into presigned URLs (TD-05 part PUTs, TD-10 Range GETs), so a URL works only when sent to the exact host:port it was signed for. Two kinds of client consume these URLs. (1) The browser, and host tools such as curl and the host-side Playwright of future phases, which reach MinIO through the **published** port. (2) Tests inside `nestjs-api` (TD-14), which reach MinIO through the **Compose network**. The root `CLAUDE.md` rule says "always use the Docker Compose service name as the host — never `localhost`". `minio:9000` does not resolve on the host, and `localhost:9000` inside a container is the container itself.

Evidence from a throwaway stack (2026-11-24): MinIO (`cgr.dev/chainguard/minio`) with network alias `minio.localhost`, listening and published on the same port.
- A URL presigned **inside** a `node:25.6.0-slim` container with `@aws-sdk/client-s3` + `s3-request-presigner` (`endpoint: http://minio.localhost:<port>`, `forcePathStyle`): in-container `dns.lookup('minio.localhost')` returns the MinIO container IP (`172.20.0.2`, through Docker DNS, not loopback; base image `hosts: files dns`), and Range GET returns **206**.
- The **same URL** from the macOS host: curl Range GET returns **206**, and a presigned PUT returns **200**. Host Node `dns.lookup` returns `::1`.
- The same signature with the host rewritten to `localhost`: **403**. This confirms the host binding.

**Options:**

### Option A: One hostname valid on both sides: `S3_PUBLIC_ENDPOINT=http://minio.localhost:9000`
- The storage service gets the Compose network alias `minio.localhost` and publishes `9000:9000` (same port inside and out). Containers resolve the alias through Docker DNS to the storage container. Browsers resolve `*.localhost` to loopback by built-in rule (RFC 6761 §6.3; Chrome since ~2017, Firefox later), and curl ≥ 7.78 hard-codes it, so the host hits the published port. One value works in dev, in tests and in the browser.
- **Pros:** One signed URL is valid everywhere, which was verified end to end above (container 206, host 206/200). No per-environment override and no host-machine setup. Tests exercise exactly the URL shape the browser will get.
- **Cons:** Needs a written **exception** to the "never `localhost`" rule (see below). Relies on `*.localhost` → loopback on the host side: browsers and curl do it, but WebKit historically lagged, and non-browser tools on some Linux hosts depend on the resolver (systemd-resolved does it, plain `/etc/hosts` setups may not). Requires the storage port to be identical inside and outside.

### Option B: Per-environment value: `http://localhost:9000` for dev/browser, `http://minio:9000` for tests
- The default env value targets the browser. The test bootstrap overrides `S3_PUBLIC_ENDPOINT` to the service name before the app boots.
- **Pros:** No new hostname; each value follows existing conventions (tests use the service name).
- **Cons:** The dev value *is* `localhost` (the same rule exception, just in the browser-facing key). Tests never sign the URL shape the browser receives, so a host/port mismatch in the browser path goes untested. Future host-side Playwright (frontend phases) cannot use URLs signed with `minio:9000`.

### Option C: Service name everywhere + host `/etc/hosts` entry (`127.0.0.1 minio`)
- `S3_PUBLIC_ENDPOINT=http://minio:9000` everywhere, and each developer machine maps `minio` to loopback.
- **Pros:** Fully compliant with the "service name" rule; one value.
- **Cons:** Manual, privileged (`sudo`) setup on every host/CI runner, invisible to the repo. Breaks silently for anyone who skips it.

**Recommendation:** **Option A (`minio.localhost` network alias + same published port)**. It is the only option with one signed URL that is verifiably valid from both the browser/host and the `nestjs-api` tests, with no per-environment override and no host setup. `S3_ENDPOINT` (internal SDK calls, worker reads) keeps the plain service name.

**Exception to root `CLAUDE.md` "Docker Networking" (to be recorded there at implementation time):** `S3_PUBLIC_ENDPOINT` is the one key allowed a `*.localhost` host. Inside containers it is a **Compose network alias of the storage service**, resolved by Docker DNS to that service, never to the container's own loopback, so the rule's intent (never point a container at itself) holds. It exists only because presigned URLs must be signed for a host that is also valid in the browser. Every other host key (DB, Redis, `S3_ENDPOINT`) keeps the service name.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message queue technology | A — BullMQ + Redis (`@nestjs/bullmq`) | _[pending]_ |
| TD-02 | Repo-wide | Video worker runtime, container topology & ffmpeg placement | A — same codebase, separate `video-worker` container, one shared dev image with ffmpeg (DoD commands unchanged) | _[pending]_ |
| TD-03 | Backend | Metadata & thumbnail tooling | A — apt ffmpeg/ffprobe + typed `execFile` wrapper | _[pending]_ |
| TD-04 | Backend | Worker access to the source video | A — FFmpeg reads presigned GET via HTTP Range | _[pending]_ |
| TD-05 | Cross-layer | Upload protocol (10GB, not via API) | A — S3 multipart, presigned parts, API-orchestrated | _[pending]_ |
| TD-06 | Backend | Upload limits & part sizing | A — env-configured, server-dictated part size | _[pending]_ |
| TD-07 | Backend | Storage layout: buckets, keys, presign endpoint | B — private `videos` + public-read `thumbnails`, keys by `videoId`, internal/public endpoints | _[pending]_ |
| TD-08 | Repo-wide | Local MinIO provisioning | A — Chainguard MinIO, digest-pinned | _[pending]_ |
| TD-09 | Cross-layer | Unique video URL identifier | B — random 11-char base64url `publicId`, UNIQUE | _[pending]_ |
| TD-10 | Cross-layer | Playback (Range/206) & download path | A — presigned GET direct from storage, issued by `@Public` API via BFF | _[pending]_ |
| TD-11 | Backend | Playback format | A — serve original (progressive Range) | _[pending]_ |
| TD-12 | Backend | Status lifecycle & failure handling | B — orthogonal processing/publication + retries + sweep (BullMQ Job Scheduler in the worker) | _[pending]_ |
| TD-13 | Backend | Rate-limit policy for video endpoints | A — `@SkipThrottle()` on video controllers + per-channel active-upload cap (+ separate tracker task) | _[pending]_ |
| TD-14 | Repo-wide | Test infra for storage/queue/worker | A — real MinIO + Redis in Compose, generated fixtures, worker in-process for e2e | _[pending]_ |
| TD-15 | Backend | Video ownership anchor | A — `Video.channelId` | _[pending]_ |
| TD-16 | Repo-wide | Presigned URL host reachability | A — `minio.localhost` network alias + same published port (documented CLAUDE.md exception) | _[pending]_ |

## Out-of-scope notes (separate tasks, not TDs here)

- **Throttler tracker behind the BFF** (TD-13): the BFF does not forward the client IP and the API uses `req.ip`, so all users share one bucket. This affects Phase 02 auth limits as well. Needs its own task (BFF forwards `X-Forwarded-For`, API trusts the proxy or uses a custom `getTracker`).
- **`phase-02-auth/TD-08` wording** says the throttler is scoped to `AuthModule`, but `APP_GUARD` is global. A doc correction belongs to that task.
- **Diagram update**: once TD-01/TD-08/TD-10 are decided, `docs/diagrams/software-arch.mermaid` "Message Queue: TBD" and the storage relations should reflect the choices.

## Sources & verified versions

Versions checked on 2026-11-24 (installed via `package-lock.json`, latest via `npm view`). Docs via context7, at the installed or nearest available version.

- Installed: `@nestjs/core 11.1.16`, `@nestjs/throttler 6.5.0`, `typeorm 0.3.28`, `joi 18.1.2`. Candidates: `@nestjs/bullmq 12.0.2` (peers `@nestjs/core ^10||^11||^12`, `bullmq ^3–^6`), `bullmq 6.7.10` (docs read at v6.5.3), `@aws-sdk/client-s3 3.1177.0`, `pg-boss 12.39.0` (`node >=22.12`), `nanoid 6.0.2` (`type: module`), `fluent-ffmpeg 2.1.3` (deprecated), `ffmpeg-static 5.3.0`, `ffprobe-static 3.1.0` (2022).
- Runtime facts: `node:25.6.0-slim` = Debian 12 bookworm, apt `ffmpeg 7:5.1.9-0+deb12u1`. `redis:8-alpine` = Redis 8.12.0. `cgr.dev/chainguard/minio:latest` = `RELEASE.2026-11-23T00-10-37Z`. Official MinIO images unresolvable (see TD-08).
- NestJS queues & standalone app: context7 `/nestjs/docs.nestjs.com` v11 — `techniques/queues.md`, `application-context.md`.
- BullMQ: context7 `/taskforcesh/bullmq` v6.5.3 — retrying-failing-jobs, job-ids, throttle-jobs pattern, going-to-production (`maxmemory-policy noeviction`), job-schedulers (`upsertJobScheduler`, `every`/`pattern`), migrate-from-v5-to-v6 (repeatable-job APIs removed in v6). `bullmq@6.0.0` published 2026-07-30.
- `@nestjs/schedule@12.0.4` (peers `@nestjs/core ^11||^12`): context7 `/nestjs/docs.nestjs.com` v11 `techniques/task-scheduling` (in-process registration at `onApplicationBootstrap`).
- TD-16 hostname: hands-on test described in TD-16 (throwaway network, removed afterwards). Compose network aliases: https://docs.docker.com/reference/compose-file/services/#aliases · Compose networking/service discovery: https://docs.docker.com/compose/how-tos/networking · `*.localhost` → loopback: RFC 6761 §6.3 https://datatracker.ietf.org/doc/html/rfc6761#section-6.3 · https://daniel.haxx.se/blog/2021/05/31/ (curl 7.78) · https://bugzilla.mozilla.org/show_bug.cgi?id=1220810 (Firefox) · https://bugs.webkit.org/show_bug.cgi?id=160504 (WebKit) · https://learn.microsoft.com/aspnet/core/test/localhost-tld
- pg-boss: context7 `/timgit/pg-boss` 12.38.2 — adapters (`send(..., { db })` transactional enqueue).
- @nestjs/throttler: context7 `/nestjs/throttler` v6.7.1 README — named throttlers, `@SkipThrottle` semantics, `getTracker` behind proxy.
- AWS SDK v3: context7 `/aws/aws-sdk-js-v3` — `lib-storage/Upload.ts` (ETag + CORS, part ordering), `s3-request-presigner` (`UNSIGNED-PAYLOAD`, default `expiresIn` 900), `GetObjectCommand` (`ResponseContentDisposition` requires a signed request), `forcePathStyle`.
- S3 limits: https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html · single PUT 5GB: https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html
- Presigned URL expiry (max 7 days; checked per request): https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html · https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html
- Browser CORS must expose ETag: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/cors.html · MinIO CORS: https://docs.min.io/aistor/administration/cors-configuration/
- Abort incomplete multipart (lifecycle): https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html · MinIO stale uploads: https://docs.min.io/aistor/operations/troubleshoot-system-path-growth/
- MinIO limits: https://docs.min.io/community/minio-object-store/operations/concepts/thresholds.html
- MinIO source-only / unmaintained: https://github.com/minio/minio (README) · https://www.infoq.com/news/2025/12/minio-s3-api-alternatives/ · Chainguard images: https://www.chainguard.dev/unchained/secure-and-free-minio-chainguard-containers
- tus/tusd S3 backend: https://tus.github.io/tusd/storage-backends/aws-s3/ · https://github.com/tus/tusd
- FFmpeg: HTTP `seekable` option https://ffmpeg.org/ffmpeg-protocols.html · `-movflags +faststart` https://ffmpeg.org/ffmpeg-formats.html · https://trac.ffmpeg.org/wiki/Encode/H.264 · ffprobe https://ffmpeg.org/ffprobe.html
- fluent-ffmpeg deprecated: https://www.npmjs.com/package/fluent-ffmpeg · https://github.com/fluent-ffmpeg
- Node `require(esm)`: https://nodejs.org/en/blog/release/v22.12.0 · https://nodejs.org/api/modules.html
