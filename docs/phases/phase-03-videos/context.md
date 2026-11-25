---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-28T19:33:34-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-24T23:28:59-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-28T19:33:34-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-28T19:33:34-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-28T19:33:34-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-28T19:33:34-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-28T19:33:34-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _The phase section names no subprojects explicitly._
**Deferred subprojects:** _None._
**Sequencing notes:** "> Depende de: Fase 01, Fase 02". Opening sentence: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A | bullmq, @nestjs/bullmq |
| phase-03-videos/TD-02 | phase | Repo-wide | Video Worker Runtime & Container Topology | decided | A | — |
| phase-03-videos/TD-03 | phase | Backend | Metadata & Thumbnail Extraction Tooling (FFmpeg/ffprobe) | decided | A | — |
| phase-03-videos/TD-04 | phase | Backend | How the Worker Reads the Source Video | decided | A | @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-05 | phase | Cross-layer | Upload Protocol for up to 10GB Without Passing Through the… | decided | A | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-06 | phase | Backend | Upload Size Limits & Part Sizing (configurable, testable) | decided | A | — |
| phase-03-videos/TD-07 | phase | Backend | Object Storage Layout — Buckets, Keys and Presigning… | decided | B | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-08 | phase | Repo-wide | Local S3-Compatible Storage Provisioning (MinIO… | decided | A | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Unique Video URL Identifier | decided | B | — |
| phase-03-videos/TD-10 | phase | Cross-layer | Playback (Range/206) and Download Delivery Path | decided | A | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-11 | phase | Backend | Playback Format (original file vs derived rendition) | decided | A | — |
| phase-03-videos/TD-12 | phase | Backend | Video Status Lifecycle & Failure Handling | decided | B | bullmq, @nestjs/bullmq |
| phase-03-videos/TD-13 | phase | Backend | Rate-Limit Policy for Video Endpoints | decided | A | @nestjs/throttler |
| phase-03-videos/TD-14 | phase | Repo-wide | Test Infrastructure for Storage, Queue and Worker | decided | A | — |
| phase-03-videos/TD-15 | phase | Backend | Video Ownership Anchor (channel vs user) | decided | A | — |
| phase-03-videos/TD-16 | phase | Repo-wide | Presigned URL Host Reachability (browser/host ↔ Compose… | decided | A | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-14 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-14 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-13, phase-03-videos/TD-14, phase-03-videos/TD-16 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-05, phase-03-videos/TD-12, phase-03-videos/TD-15 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-12, phase-03-videos/TD-14 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-12, phase-03-videos/TD-14 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-09 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-13, phase-03-videos/TD-16 |
| Download do vídeo pelo usuário | phase-03-videos/TD-10, phase-03-videos/TD-13, phase-03-videos/TD-16 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** It is the only option where retries, exponential backoff, `jobId` dedup and failed-job inspection come from the official Nest integration without custom plumbing, and it matches the diagram's separate queue container. The real cost is the non-transactional enqueue: it is covered by an idempotent `jobId = videoId` plus a periodic reconciliation (TD-12). pg-boss (B) is the honest runner-up if the team prefers zero new infrastructure and transactional enqueue over Nest-native ergonomics.
**Note:** Pre-implementation review (2026-11-24): in `bullmq@6.7.10`, `ioredis` is an **optional** peer dependency (`npm view bullmq@6.7.10 peerDependenciesMeta`), so npm does not install it and BullMQ fails with "could not load the optional 'ioredis' package". `ioredis` is pinned explicitly alongside `bullmq` (see `library-refs.md`). By design, producers' `add` waits while Redis is unreachable (bullmq docs, "Failing fast when Redis is down"). The API bounds the post-commit enqueue with a timeout instead of `enableOfflineQueue: false`, because the connection is shared with the worker.
**Libraries:** bullmq, @nestjs/bullmq

### phase-03-videos/TD-02

**Recommendation:** Process-level isolation is what "sem impacto na performance" needs at runtime, and sharing the dev image keeps every test, including real ffprobe/ffmpeg integration and e2e, in `nestjs-api`. **DoD commands stay exactly as they are** (`docker compose exec nestjs-api npm test`, `… npm run test:e2e`, `… npx tsc --noEmit`, `… npm run lint`). What changes is the precondition: the image must be rebuilt once (`docker compose build`), and `minio` + `redis` must be up and ready before the suites (TD-14). B splits the DoD gate across two containers for an image-size gain that only matters in production, C puts FFmpeg next to the HTTP server, and D pays a monorepo-tooling cost Phase 03 does not need.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** The Debian package gives a reproducible, arch-independent ffmpeg/ffprobe in the shared dev image (TD-02 A), so the same binary serves the worker at runtime and the tests in `nestjs-api`, and a thin `execFile` wrapper replaces the deprecated `fluent-ffmpeg` without adopting another wrapper. Thumbnail frame policy (e.g. a fixed fraction of duration, clamped to the first seconds for short clips) is a parameter of this TD, not a separate decision.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** The phase needs only metadata and one frame, so streaming the whole 10GB through the worker's disk is the dominant cost Option B adds for no product gain. Option B stays a valid fallback for a future transcoding phase, where the full read is unavoidable.
**Libraries:** @aws-sdk/s3-request-presigner

### phase-03-videos/TD-05

**Recommendation:** It is the only option where no service other than the object store touches video bytes, and resumability comes from `ListParts`. The draft-on-initiate and enqueue-on-complete hooks are plain API endpoints that follow the existing JWT/envelope conventions. tus (B) buys finer-grained resume at the price of an extra data-path service and a hook contract. Note on the strict-BFF rule: the browser talks to **storage** (presigned URLs), never to the Nest API, which is the carve-out `next-frontend-config-base/TD-03` already anticipated.
**Note:** Pre-implementation review (2026-11-24): the draft row created on initiate also carries a `title`. The challenge's "Persistência" requirement lists title among the minimum video fields. `title` is optional on initiate and defaults to the `fileName` without its extension (or the whole `fileName` when that is empty). Editing it belongs to Phase 04 ("Edição das informações do vídeo").
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-06

**Recommendation:** It follows the Phase 01 config convention and is the mechanism that makes "10GB" testable without 10GB: the same code path runs with a 12 MiB ceiling and 5 MiB parts in tests.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** **private `videos` + public-read `thumbnails`, keys by `videoId`**, with two S3 endpoints in config: `S3_ENDPOINT` (internal, Compose service name, for SDK calls and the worker's own presigned reads in TD-04) and `S3_PUBLIC_ENDPOINT` (the host embedded in browser-facing presigned URLs and public thumbnail URLs). The value of `S3_PUBLIC_ENDPOINT`, which must be reachable from both the browser/host and the tests inside `nestjs-api`, is decided in TD-16. It keeps the 10GB originals private while giving listing pages stable thumbnail URLs, and it lets cost controls (incomplete-upload cleanup, future quotas) target only the bucket that grows. Phase 03 stores only the original + one thumbnail per video, so there are no derivative copies (see TD-11).
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-08

**Recommendation:** It is the only option verified to run today that keeps the documented MinIO target, with no build tooling. The application code talks plain S3 (`@aws-sdk/client-s3`, `forcePathStyle`), so moving to B, C or real S3 later is a compose change, not a code change.
**Note:** Pre-implementation review (2026-11-24), verified against the cached images:
- `cgr.dev/chainguard/minio-client` has `mc` as its entrypoint and no `sh`, so it cannot run a multi-step init. `cgr.dev/chainguard/minio` ships both `sh` and `mc`, so the one-shot `minio-init` runs from the `minio` image (same digest) with `sh -c`. `minio-client` is not used.
- `mc cors set` fails with "not implemented" on this MinIO build, so no per-bucket CORS is configured. MinIO's default CORS already exposes `ETag` (`Access-Control-Expose-Headers`); `MINIO_API_CORS_ALLOW_ORIGIN` remains available if origins ever need narrowing.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** It is the only option that is short **and** unguessable, both of which are required (short by the attention point, unguessable by Phase 05 unlisted). The "never conflicts" guarantee comes from the DB constraint, not from probability alone.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** It is the only option where Range/206 traffic never touches the throttled, BFF-shared API path while drafts and unlisted videos stay private. It resolves the diagram/BFF tension cleanly: strict BFF governs the **API**, and media bytes come from storage via short-lived signed URLs. Which statuses may be played (e.g. only `ready`) is enforced by the issuing endpoint (TD-12).
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner
**Note:** Phase 03 access rule (resolves validation AMB-1): the URL-issuing endpoint is `@Public` with optional auth. The owner (channel owner) gets playback/download URLs for their own videos once `processingStatus = ready`, even while the video is a draft; anyone else gets them only when the video is published. The publication gate is wired now and becomes effective when Phase 04 adds publishing. Drafts therefore stay private, as this Recommendation requires.

### phase-03-videos/TD-11

**Recommendation:** **serve the original, progressive Range** for Phase 03. It meets "reprodução sem download completo" with zero added CPU/storage, and the phase scope is metadata, not transcoding. What is lost: guaranteed fast-start and codec universality. Option B is the cheapest upgrade if fast-start becomes a product requirement, and C belongs to a dedicated future phase.
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** Keeping the technical lifecycle separate from "rascunho" lets Phase 04 add publication/visibility without reshaping this machine. The sweep is what makes the non-transactional enqueue (TD-01 A) and abandoned 10GB multipart uploads safe, and the latter is a direct storage-cost control (Pontos de Atenção). MinIO's server-side stale-upload expiry (`api stale_uploads_expiry`, default 24h per MinIO docs) and S3's `AbortIncompleteMultipartUpload` lifecycle rule are backstops, not substitutes, because neither updates the DB row.

**Sweep scheduling mechanism (part of Option B):**

- **Chosen: BullMQ Job Scheduler, running in the worker process.** On worker bootstrap, the worker calls `queue.upsertJobScheduler('video-maintenance-sweep', { every: <ms> }, { name: 'sweep' })` on a dedicated `video-maintenance` queue, and a `@Processor('video-maintenance')` in `WorkerModule` executes it. `upsert` is idempotent by scheduler ID, so restarts or extra worker replicas re-declare the same scheduler instead of stacking duplicates, and each tick becomes one job processed by one worker. The interval and the stale threshold are env-configured (TD-06 pattern: e.g. `VIDEO_SWEEP_INTERVAL_MS`, `VIDEO_UPLOAD_STALE_AFTER_MS`). Tests invoke the processor directly instead of waiting for a tick. Library: `bullmq` (same dependency as TD-01; latest `6.7.10`, docs read at v6.5.3). In v6 the legacy repeatable-job API (`add(..., { repeat })`, `getRepeatableJobs`, `removeRepeatable*`) is **removed** in favour of Job Schedulers, so the scheduler API is the only supported path.
- **Why the worker, not the API:** the sweep calls `AbortMultipartUpload`/`ListParts` on storage and writes status. Keeping it beside the processing processor keeps the API request-path-only and puts all background mutations of `processingStatus` in one process.
- **Considered alternative: `@nestjs/schedule` `@Cron`** (`@nestjs/schedule@12.0.4`, peers `@nestjs/core ^11||^12`). The cron is registered in-process at `onApplicationBootstrap` (Nest docs, `techniques/task-scheduling`), so every process that imports `ScheduleModule` runs its own timer, and multiple worker replicas would sweep concurrently unless a lock is added. It is also one more dependency for something the queue already provides. Rejected.
- **Dependency:** valid if TD-01 = A. If TD-01 = B (pg-boss), this mechanism must be re-researched against pg-boss's own scheduling.

**Note:** Pre-implementation review (2026-11-24): mapping to the challenge's status cycle "rascunho → processando → pronto/erro":
- rascunho = `publication_status = 'draft'` + `processing_status = 'uploading'`;
- processando = `processing`;
- pronto = `ready`;
- erro = `failed` (with `failure_reason`).

The video stays `draft` on the publication axis through the whole phase. This mapping must be stated in the Data Model and in the videos section of `nestjs-project/CLAUDE.md`.
**Libraries:** bullmq, @nestjs/bullmq

### phase-03-videos/TD-13

**Recommendation:** **`@SkipThrottle()` on video controllers**, combined with TD-05/TD-10's design that keeps per-upload/per-view API calls O(1). Under the current shared-IP tracker, any IP-based limit on video routes is a site-wide limit, so B and C cap legitimate traffic. **Accepted residual risk:** with A, the authenticated `POST /videos/uploads` has no rate limit, so one account could open unlimited drafts + multipart uploads (DB rows and orphan parts). The mitigation accepted for this phase is a per-channel cap on videos in `processingStatus = uploading` (env-configured, domain error in the `{statusCode,error,message}` envelope when exceeded), plus TD-12's sweep, which fails and aborts stale uploads. **Separate task (out of scope):** make the throttler track the real client (BFF forwards client IP, API trusts the proxy / custom `getTracker`). After that, a per-client `videos` policy (B) becomes meaningful.
**Libraries:** @nestjs/throttler

### phase-03-videos/TD-14

**Recommendation:** It extends the existing shared-Compose test model instead of introducing Docker-in-Docker, it is the only option that exercises the S3/FFmpeg behaviours most likely to break, and it keeps every DoD command running unchanged in `nestjs-api`.
**Libraries:** —

### phase-03-videos/TD-15

**Recommendation:** The product's ownership unit is the channel (panel, public page, watch page), and anchoring there keeps Phases 04–07 reads direct. The extra user→channel lookup happens only on writes.
**Libraries:** —

### phase-03-videos/TD-16

**Recommendation:** It is the only option with one signed URL that is verifiably valid from both the browser/host and the `nestjs-api` tests, with no per-environment override and no host setup. `S3_ENDPOINT` (internal SDK calls, worker reads) keeps the plain service name.

**Exception to root `CLAUDE.md` "Docker Networking" (to be recorded there at implementation time):** `S3_PUBLIC_ENDPOINT` is the one key allowed a `*.localhost` host. Inside containers it is a **Compose network alias of the storage service**, resolved by Docker DNS to that service, never to the container's own loopback, so the rule's intent (never point a container at itself) holds. It exists only because presigned URLs must be signed for a host that is also valid in the browser. Every other host key (DB, Redis, `S3_ENDPOINT`) keeps the service name.

**Note:** Pre-implementation review (2026-11-24): curl (≥ 7.78) hard-codes `*.localhost` to 127.0.0.1 even **inside** containers, so `curl http://minio.localhost:9000` from `nestjs-api` hits the container itself (connection refused). Node (`fetch`/`dns.lookup`) and `getent` resolve the Docker alias correctly, and so does the app's AWS SDK. In-container checks of this host therefore use `node -e "fetch(...)"` or `mc ready` inside the `minio` service, never curl. From the host, curl works as intended.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** Ambos (runtime UI + `openapi.json` exportado) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Apenas em dev/staging — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory phase-03-videos and then rerun /plan-context phase-03-videos to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
