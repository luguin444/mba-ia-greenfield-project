---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-24T21:11:18-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-24T21:10:09-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-24T21:09:01-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-28T19:33:34-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of up to 10GB straight to object storage (S3 multipart via presigned URLs, with the video pre-registered as a draft when the upload starts), automatic background processing through a queue and an FFmpeg worker (duration/metadata extraction and a thumbnail from one frame), a unique short URL per video, and streaming playback (HTTP Range/206) plus download served from storage — making "upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas" true end to end in `nestjs-project`.

---

## Step Implementations

<!-- SIs will be written in Phase B -->

---

## Technical Specifications

### Data Model

**Naming rule for this phase:** DB columns and entity properties follow the existing snake_case convention (`Channel.user_id`, `User.is_confirmed`). Wire names (JSON in API responses) are camelCase, exactly as the TDs spell them (`publicId`, `processingStatus`, `failureReason`, `videoId`, `uploadId`, `partSize`, `expiresAt`). Response DTOs do the mapping, and entities are never serialized directly.

#### Video

Entity file: `src/videos/entities/video.entity.ts`, table `videos`.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | Generated in the app (`crypto.randomUUID()`) **before** insert, because the storage key and the multipart upload need it before the row exists. Wire: `id` / `videoId` |
| public_id | varchar(11) | unique, not null | `randomBytes(8).toString('base64url')` (11 chars, 64 random bits), with a retry on unique violation (max 5 attempts, same `QueryFailedError` code `23505` + column detail check as `ChannelsService`) (per `phase-03-videos/TD-09`). Wire: `publicId` |
| channel_id | uuid | FK → `channels.id`, not null | Ownership anchor (per `phase-03-videos/TD-15`). Resolved from the JWT `sub` through `channels.user_id` on writes |
| processing_status | enum `videos_processing_status_enum` | not null, default `'uploading'`, values `'uploading'`, `'processing'`, `'ready'`, `'failed'` | Technical lifecycle (per `phase-03-videos/TD-12`). Wire: `processingStatus` |
| publication_status | enum `videos_publication_status_enum` | not null, default `'draft'`, values `'draft'` | Publication axis, kept separate from processing (per `phase-03-videos/TD-12`). `draft` is the only value in Phase 03. Phase 04 adds `published`/visibility via `ALTER TYPE … ADD VALUE`. Wire: `publicationStatus` |
| failure_reason | varchar(64) | nullable | Set only when `processing_status = 'failed'`. Closed set: `UPLOAD_ABANDONED`, `UPLOAD_ABORTED`, `UPLOAD_SIZE_MISMATCH`, `INVALID_MEDIA`, `PROCESSING_ERROR` (see Events/Messages). Wire: `failureReason` |
| original_filename | varchar(255) | not null | `fileName` declared on initiate. Used only for the download `Content-Disposition`, never in storage keys (per `phase-03-videos/TD-07`) |
| mime_type | varchar(127) | not null | Declared on initiate, must match `^video\/` |
| size_bytes | bigint | not null | Declared size. Column transformer `string ↔ number` (pg returns `bigint` as string, and values ≤ 10 GiB are well below 2^53) |
| upload_id | text | nullable | S3 multipart `UploadId`. Set on initiate, cleared (`null`) on complete, abort and sweep |
| upload_part_size_bytes | bigint | not null | Server-dictated `partSize = max(VIDEO_UPLOAD_PART_SIZE_BYTES, ceil(size_bytes / 10000))`, frozen at initiate (per `phase-03-videos/TD-06`). Same transformer as `size_bytes`. `partCount = ceil(size_bytes / upload_part_size_bytes)` is derived, not stored |
| source_key | varchar(255) | not null | `{id}/source` in the private `S3_VIDEOS_BUCKET` (per `phase-03-videos/TD-07`) |
| thumbnail_key | varchar(255) | nullable | `{id}/default.jpg` in the public-read `S3_THUMBNAILS_BUCKET`. Set by the worker (per `phase-03-videos/TD-07`, `phase-03-videos/TD-03`) |
| duration_seconds | double precision | nullable | ffprobe `format.duration`. Set by the worker |
| width | integer | nullable | First video stream `width` |
| height | integer | nullable | First video stream `height` |
| video_codec | varchar(64) | nullable | First video stream `codec_name` |
| audio_codec | varchar(64) | nullable | First audio stream `codec_name`, `null` when there is no audio |
| format_name | varchar(128) | nullable | ffprobe `format.format_name` |
| processed_at | timestamp | nullable | Set when `processing_status` becomes `'ready'` |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn`. Also bumped by `POST /videos/:id/upload/part-urls` ("last upload activity", read by the sweep) |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`). No inverse `@OneToMany` on `Channel` in this phase, because ownership checks compare `video.channel_id` with the caller's channel id.
**Indexes:** `(public_id)` unique; `(channel_id, processing_status)` for the active-upload cap count; `(processing_status, updated_at)` for the maintenance sweep.

**State machine (`processing_status`):** `uploading → processing → ready`; `uploading → failed` (abort, sweep, size mismatch on complete); `processing → failed` (invalid media, retries exhausted). `ready` and `failed` are terminal in Phase 03. Re-running the job for a video that is already `ready` overwrites metadata and the thumbnail (idempotent worker, per `phase-03-videos/TD-12`).

**Registration & migration:**
- `TypeOrmModule.forFeature([Video])` in `VideosModule` (API) and in `WorkerModule` (worker). Both roots use `autoLoadEntities: true`, built from the single `databaseConfig` factory (inherited convention: never duplicate connection params, so the TypeORM options builder is shared between `AppModule` and `WorkerModule`).
- Migration `CreateVideos` generated by the CLI inside the container (`npm run migration:generate -- src/database/migrations/CreateVideos`, because the `data-source.ts` entity glob already picks up `*.entity.ts`), then reviewed for both enum types, the FK and the three indexes.
- Test fallout that must land with the migration: `src/database/migrations.integration-spec.ts` (`MANAGED_TABLES` + `videos`, `MANAGED_ENUM_TYPES` + both new enum types, expected migration count 3), `cleanAllTables` (delete `videos` before `channels`), and every `ALL_ENTITIES` list in module specs.

**Out of this phase:** title, description, visibility and custom thumbnails (Phase 04).

### API Contracts

**Cross-cutting rules for every endpoint below:**
- Errors use the inherited envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`). Domain errors are `DomainException` subclasses declared in `src/videos/videos.exceptions.ts` (not in `src/common`, so they stay owned by the videos domain).
- OpenAPI (per `openapi-docs-nestjs/TD-01`, revision 2026-05-12): controllers carry `@ApiTags('videos')`, every operation has `@ApiOperation`, plus one `@ApiResponse` per documented status. Success bodies are typed by response DTO classes, and every error status points to `getSchemaPath(ApiErrorEnvelope)`. JWT routes use `@ApiBearerAuth('access-token')`. The committed `openapi.json` is regenerated with `npm run openapi:export` (per `openapi-docs-nestjs/TD-02`).
- Every video controller is `@SkipThrottle()` (per `phase-03-videos/TD-13`). The project has a single unnamed throttler, so the no-arg form is enough (`library-refs.md` → `@nestjs/throttler`).
- Video bytes never pass through the API: parts are PUT straight to storage and playback/download is fetched from storage (per `phase-03-videos/TD-05`, `phase-03-videos/TD-10`). Storage-side errors are S3 XML, outside this envelope.
- Every presigned URL that reaches the client is signed by the **public** S3 client (`S3_PUBLIC_ENDPOINT`). Internal SDK calls use `S3_ENDPOINT` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-16`).
- Owner-only routes identify the video by `:id` (uuid, `ParseUUIDPipe`). Viewer routes use `:publicId` (per `phase-03-videos/TD-09`).

**Shared response shape — `VideoResponse`** (used by `GET /videos/:id` and `POST /videos/:id/upload/complete`):
- id: string (uuid)
- publicId: string (11 chars, base64url)
- processingStatus: `'uploading' | 'processing' | 'ready' | 'failed'`
- publicationStatus: `'draft'`
- failureReason: string | null
- fileName: string — `original_filename`
- mimeType: string
- sizeBytes: number
- durationSeconds: number | null
- width: number | null
- height: number | null
- videoCodec: string | null
- audioCodec: string | null
- formatName: string | null
- thumbnailUrl: string | null — public, unsigned `{S3_PUBLIC_ENDPOINT}/{S3_THUMBNAILS_BUCKET}/{thumbnail_key}` (path-style, public-read bucket, per `phase-03-videos/TD-07`)
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)
- processedAt: string (ISO-8601) | null

**Shared item shapes:** `PartUrl` = `{ partNumber: number, url: string }`; `UploadedPart` = `{ partNumber: number, size: number, etag: string }`.

---

#### POST /videos/uploads (SI-NN.X)

Initiate upload: pre-registers the video as a draft and opens the multipart upload (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-13`, `phase-03-videos/TD-15`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- fileName: string, required — 1–255 characters
- sizeBytes: integer, required — ≥ 1 (the upper bound is a domain check, not a DTO rule, so it returns `VIDEO_TOO_LARGE`)
- mimeType: string, required — max 127, matches `^video\/[\w.+-]+$`

**Behavior (order matters):**
1. Resolve the caller's channel by `channels.user_id = sub`.
2. Reject `sizeBytes > VIDEO_MAX_UPLOAD_BYTES`.
3. In one transaction holding a `pessimistic_write` lock on the caller's `channels` row: count the channel's videos with `processing_status = 'uploading'`. Reject when the count is ≥ `VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL`. Otherwise generate `id`, call `CreateMultipartUpload` on `{id}/source`, then insert the `Video` (`uploading`, `draft`, `upload_id`, `upload_part_size_bytes`, `public_id` with retry).
4. If the insert fails after `CreateMultipartUpload` succeeded, call `AbortMultipartUpload` best-effort and rethrow.
5. Presign `UploadPart` URLs for parts `1..min(partCount, 100)` with TTL `VIDEO_UPLOAD_PART_URL_TTL_SECONDS`.

**Response 201:**
- videoId: string (uuid)
- publicId: string
- uploadId: string
- partSize: number (bytes)
- partCount: number
- parts: `PartUrl[]` — first batch, at most 100, ascending `partNumber`
- expiresAt: string (ISO-8601) — expiry of the part URLs in this response

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation
- 401 Unauthorized: missing/invalid access token
- 404 CHANNEL_NOT_FOUND: the authenticated user has no channel (defensive, since Phase 02 creates one per user)
- 409 ACTIVE_UPLOAD_LIMIT_REACHED: the channel already has `VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL` videos in `uploading`
- 413 VIDEO_TOO_LARGE: `sizeBytes` > `VIDEO_MAX_UPLOAD_BYTES`

---

#### POST /videos/:id/upload/part-urls (SI-NN.X)

Signs the parts that are still missing. This is the resume path: `ListParts` tells which parts are already stored (per `phase-03-videos/TD-05`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request path parameters:**
- id: uuid

**Request body:**
- partNumbers: integer[], optional — 1–100 items, unique, each ≥ 1. When omitted, the API signs the first ≤ 100 **missing** parts in ascending order. Explicitly listed parts are signed even if already uploaded (re-PUT overwrites that part).

**Behavior:** owner + `processing_status = 'uploading'` check → `ListParts` (paginated until exhausted) → validate every requested `partNumber` ≤ `partCount` → presign → touch `updated_at` (keeps the upload from being considered stale by the sweep).

**Response 200:**
- videoId: string (uuid)
- uploadId: string
- partSize: number
- partCount: number
- uploadedParts: `UploadedPart[]` — every part already stored, ascending
- parts: `PartUrl[]` — newly signed URLs (empty array when nothing is missing and no `partNumbers` were given)
- expiresAt: string (ISO-8601)

**Error responses:**
- 400 VALIDATION_ERROR: `id` not a uuid, or body fails schema validation
- 400 INVALID_PART_NUMBER: a requested `partNumber` > `partCount`
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: video does not exist **or** caller is not the owner
- 409 INVALID_VIDEO_STATE: `processing_status` ≠ `'uploading'`

---

#### POST /videos/:id/upload/complete (SI-NN.X)

Finishes the multipart upload, verifies the size and enqueues processing (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-01`, `phase-03-videos/TD-12`).

**Request headers:**
- Authorization: Bearer {access_token}

**Request path parameters:**
- id: uuid

**Request body:** none. The server builds the `{ PartNumber, ETag }` list from `ListParts`, so client-held ETags are neither needed nor trusted.

**Behavior (order matters):**
1. Owner + `processing_status = 'uploading'` check.
2. `ListParts`: if any part in `1..partCount` is missing, reject with `UPLOAD_INCOMPLETE`. The video stays `uploading` and is resumable.
3. If the sum of the listed part sizes ≠ `size_bytes`, reject with `UPLOAD_SIZE_MISMATCH`. The video stays `uploading`, so the client can re-PUT a part or abort.
4. `CompleteMultipartUpload` with the parts sorted ascending by `PartNumber`.
5. `HeadObject` on `source_key` (backstop). If `ContentLength` ≠ `size_bytes` or > `VIDEO_MAX_UPLOAD_BYTES`, call `DeleteObject`, set `processing_status = 'failed'`, `failure_reason = 'UPLOAD_SIZE_MISMATCH'`, `upload_id = null`, and reject with `UPLOAD_SIZE_MISMATCH`.
6. Set `processing_status = 'processing'`, `upload_id = null`, and commit.
7. After the commit, enqueue `process-video` (see Events/Messages). If the enqueue throws, the error is logged and **swallowed**, and the response is still 202. The row is already `processing`, and the maintenance sweep re-enqueues it (non-transactional dual write covered per `phase-03-videos/TD-01`, `phase-03-videos/TD-12`).

**Response 202:** `VideoResponse` with `processingStatus: 'processing'`.

**Error responses:**
- 400 VALIDATION_ERROR: `id` not a uuid
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: video does not exist **or** caller is not the owner
- 409 INVALID_VIDEO_STATE: `processing_status` ≠ `'uploading'` (this includes a second `complete` call)
- 409 UPLOAD_INCOMPLETE: parts missing. `message` names the missing part numbers (first 20, then `…`)
- 422 UPLOAD_SIZE_MISMATCH: listed parts or the stored object size ≠ declared `sizeBytes`, or the stored object exceeds the max

---

#### DELETE /videos/:id/upload (SI-NN.X)

Aborts an in-progress upload (per `phase-03-videos/TD-05`, `phase-03-videos/TD-12`).

**Request headers:**
- Authorization: Bearer {access_token}

**Request path parameters:**
- id: uuid

**Behavior:** owner + `processing_status = 'uploading'` check → `AbortMultipartUpload` (`NoSuchUpload` tolerated) → `processing_status = 'failed'`, `failure_reason = 'UPLOAD_ABORTED'`, `upload_id = null`. This frees an active-upload slot (per `phase-03-videos/TD-13`).

**Response 204:** No content.

**Error responses:**
- 400 VALIDATION_ERROR: `id` not a uuid
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: video does not exist **or** caller is not the owner
- 409 INVALID_VIDEO_STATE: `processing_status` ≠ `'uploading'`

---

#### GET /videos/:id (SI-NN.X)

Owner-only detail and status, used to poll processing after `complete`.

**Request headers:**
- Authorization: Bearer {access_token}

**Request path parameters:**
- id: uuid

**Response 200:** `VideoResponse`.

**Error responses:**
- 400 VALIDATION_ERROR: `id` not a uuid
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: video does not exist **or** caller is not the owner

---

#### GET /videos/:publicId/playback (SI-NN.X)

Issues a short-lived presigned GET for streaming. The browser's `<video>` then makes Range/206 requests straight to storage, serving the original file as uploaded (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`). `@OptionalAuth()` route (see Authorization Matrix).

**Request headers:**
- Authorization: Bearer {access_token} — **optional**

**Request path parameters:**
- publicId: string. Anything not matching `^[A-Za-z0-9_-]{11}$` is answered with 404 `VIDEO_NOT_FOUND`, with no DB hit.

**Behavior:** load by `public_id`. **Visible** = caller is the owner **or** `publication_status ≠ 'draft'`. If not visible, 404. If visible but `processing_status ≠ 'ready'`, 409. Otherwise presign `GetObject` on `source_key` with the public client and TTL `VIDEO_PLAYBACK_URL_TTL_SECONDS`. In Phase 03 every video is `draft`, so only the owner gets a URL. The gate becomes effective for others when Phase 04 adds publication values (TD-10 Note).

**Response 200:**
- url: string — presigned GET
- expiresAt: string (ISO-8601)

Response header `Cache-Control: no-store`.

**Error responses:**
- 401 Unauthorized: an `Authorization` header is present but the token is invalid/expired (lets the BFF single-flight refresh, `phase-02-auth-frontend/TD-03`, kick in)
- 404 VIDEO_NOT_FOUND: no such `publicId`, malformed `publicId`, or not visible to the caller
- 409 VIDEO_NOT_READY: visible to the caller but `processing_status` ≠ `'ready'`

---

#### GET /videos/:publicId/download (SI-NN.X)

Same access rules and response shape as playback. The presigned GET carries `ResponseContentDisposition: attachment; filename="<ascii-sanitized original_filename>"; filename*=UTF-8''<RFC 5987-encoded original_filename>` (per `phase-03-videos/TD-10`, `library-refs.md` → `@aws-sdk/s3-request-presigner`). `@OptionalAuth()` route.

**Request headers:**
- Authorization: Bearer {access_token} — **optional**

**Request path parameters:**
- publicId: string (same rule as playback)

**Response 200:**
- url: string — presigned GET with the attachment disposition
- expiresAt: string (ISO-8601)

Response header `Cache-Control: no-store`.

**Error responses:**
- 401 Unauthorized: an `Authorization` header is present but the token is invalid/expired
- 404 VIDEO_NOT_FOUND: no such `publicId`, malformed `publicId`, or not visible to the caller
- 409 VIDEO_NOT_READY: visible to the caller but `processing_status` ≠ `'ready'`

---

#### Validation Rules — video endpoints

- `fileName`: required string, trimmed, 1–255 characters
- `sizeBytes`: required integer, ≥ 1 (`@IsInt`, `@Min(1)`; the max is checked in the domain → `VIDEO_TOO_LARGE`)
- `mimeType`: required string, max 127, `^video\/[\w.+-]+$`
- `partNumbers`: optional array, `@ArrayMinSize(1)`, `@ArrayMaxSize(100)`, `@ArrayUnique()`, each `@IsInt` `@Min(1)`. The upper bound (`partCount`) is checked in the domain → `INVALID_PART_NUMBER`
- `:id`: `ParseUUIDPipe` → 400 `VALIDATION_ERROR` on failure
- `:publicId`: format check in the service → 404 `VIDEO_NOT_FOUND` on failure (no existence oracle, no DB hit)
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) is inherited, so unknown body keys are rejected with 400

### Authorization Matrix

"Owner" = authenticated user whose channel (`channels.user_id = sub`) is `video.channel_id` (per `phase-03-videos/TD-15`). "Authenticated" = valid access token but not the owner.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner | Notes |
|----------|-----------|---------------------------|-------|-------|
| POST /videos/uploads | ✗ 401 | ✓ | ✓ | Any authenticated user uploads to **their own** channel; there is no target channel in the request |
| POST /videos/:id/upload/part-urls | ✗ 401 | ✗ 404 | ✓ | Non-owner gets 404 `VIDEO_NOT_FOUND`, never 403 |
| POST /videos/:id/upload/complete | ✗ 401 | ✗ 404 | ✓ | Non-owner gets 404 `VIDEO_NOT_FOUND`, never 403 |
| DELETE /videos/:id/upload | ✗ 401 | ✗ 404 | ✓ | Non-owner gets 404 `VIDEO_NOT_FOUND`, never 403 |
| GET /videos/:id | ✗ 401 | ✗ 404 | ✓ | Owner-only status/detail |
| GET /videos/:publicId/playback | draft: ✗ 404 · published + ready: ✓ | draft: ✗ 404 · published + ready: ✓ | ready: ✓ · not ready: 409 | `@OptionalAuth()`. Phase 03 has only `draft`, so in practice owner-only |
| GET /videos/:publicId/download | draft: ✗ 404 · published + ready: ✓ | draft: ✗ 404 · published + ready: ✓ | ready: ✓ · not ready: 409 | `@OptionalAuth()`. Same rule as playback |

**Rule — hide, don't forbid:** whenever the caller may not know the video exists (non-owner on an owner route, or anonymous/non-owner on an unpublished video), the answer is **404 `VIDEO_NOT_FOUND`**, byte-identical to the "no such video" response. 403 is never used for videos. A non-owner on a visible-but-not-ready video (impossible until Phase 04 publishes) also gets 409 `VIDEO_NOT_READY`, because visibility is decided first.

**Optional-auth mechanism (per `phase-03-videos/TD-10` Note).** Today `JwtAuthGuard` (`src/auth/guards/jwt-auth.guard.ts`) returns `true` for `@Public()` routes **without reading the token**, so `@Public()` alone cannot tell the owner apart. Phase 03 adds:
- `IS_OPTIONAL_AUTH_KEY` + `@OptionalAuth()` in `src/auth/decorators/optional-auth.decorator.ts`, implemented as `applyDecorators(Public(), SetMetadata(IS_OPTIONAL_AUTH_KEY, true))`, so the route stays `@Public` as the TD says and is also flagged optional-auth.
- `JwtAuthGuard.canActivate` reads `IS_OPTIONAL_AUTH_KEY` (same `getAllAndOverride` on handler + class) **before** the `isPublic` short-circuit:
  - optional-auth + no `Authorization` header (or not `Bearer `) → `request.user` stays `undefined`, return `true` (anonymous);
  - optional-auth + `Bearer` token that verifies → `request.user = payload`, return `true`;
  - optional-auth + `Bearer` token that fails verification (invalid/expired) → `UnauthorizedException` (401). Silently degrading to anonymous would turn an expired owner session into a misleading 404 and would never trigger the BFF refresh;
  - plain `@Public()` (no optional flag) → unchanged: `true` without reading the header. Existing auth routes keep their behaviour.
- Handlers on optional-auth routes read the caller with the existing `@CurrentUser()` and type the parameter `JwtPayload | undefined`. `CurrentUser` itself is unchanged, so `/auth/*` handlers keep `JwtPayload`.
- OpenAPI: optional-auth operations declare `@ApiBearerAuth('access-token')` and state "authentication optional" in `@ApiOperation.description`.
- Owner resolution on optional-auth routes: if `request.user` is set, resolve the caller's channel and compare with `video.channel_id`. Anonymous callers are never owners.
- Tests: unit tests for the four guard branches above (extends `jwt-auth.guard.spec.ts`) + e2e for anonymous / non-owner / owner / expired-token on playback.

### Error Catalog

**Error response format:** inherited from Phase 02 (`{ statusCode, error, message }`, rendered by `DomainExceptionFilter`). Validation failures keep `error: "VALIDATION_ERROR"` with `message: string[]` (`ValidationExceptionFilter`). The classes below extend `DomainException` and live in `src/videos/videos.exceptions.ts`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_TOO_LARGE | 413 | Video exceeds the maximum upload size | `POST /videos/uploads` with `sizeBytes` > `VIDEO_MAX_UPLOAD_BYTES` (per `phase-03-videos/TD-06`) |
| ACTIVE_UPLOAD_LIMIT_REACHED | 409 | Too many uploads in progress for this channel | `POST /videos/uploads` when the channel already has ≥ `VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL` videos with `processing_status = 'uploading'` (per `phase-03-videos/TD-13`) |
| CHANNEL_NOT_FOUND | 404 | Channel not found for the authenticated user | `POST /videos/uploads` when no `channels` row has `user_id = sub` (defensive invariant guard) |
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown `id`/`publicId`, malformed `publicId`, non-owner on an owner route, or anonymous/non-owner on an unpublished video (hide-don't-forbid rule, per `phase-03-videos/TD-10` Note) |
| INVALID_VIDEO_STATE | 409 | Operation not allowed in the current video state | `part-urls`, `complete` or `DELETE …/upload` when `processing_status` ≠ `'uploading'` (e.g. `complete` on a video that is already `processing`, `ready` or `failed`) (per `phase-03-videos/TD-12`) |
| INVALID_PART_NUMBER | 400 | Part number out of range | `POST /videos/:id/upload/part-urls` with a `partNumber` > `partCount` |
| UPLOAD_INCOMPLETE | 409 | Upload is missing parts: {n1, n2, …} | `POST /videos/:id/upload/complete` when `ListParts` lacks any part in `1..partCount`. The video stays `uploading` (resumable) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded size does not match the declared size | `complete` when the sum of listed parts ≠ `size_bytes` (video stays `uploading`), **or** the post-complete `HeadObject` size ≠ `size_bytes` / > max (object deleted, video → `failed` with `failure_reason = 'UPLOAD_SIZE_MISMATCH'`) (per `phase-03-videos/TD-06`) |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | `GET /videos/:publicId/playback` or `/download` when the video is visible to the caller but `processing_status` ≠ `'ready'` |

Inherited, not redefined: `401` from `JwtAuthGuard` (missing/invalid token on JWT routes; invalid/expired token sent to an `@OptionalAuth()` route) and `400 VALIDATION_ERROR`.

**`failure_reason` values** (stored on the row, exposed as `failureReason`; these are not HTTP errors):

| Value | Set by | When |
|-------|--------|------|
| UPLOAD_ABORTED | API `DELETE /videos/:id/upload` | Owner aborted the upload |
| UPLOAD_SIZE_MISMATCH | API `complete` | Post-complete `HeadObject` check failed (object deleted) |
| UPLOAD_ABANDONED | Worker maintenance sweep | `uploading` with no activity for `VIDEO_UPLOAD_STALE_AFTER_MS` (multipart aborted) |
| INVALID_MEDIA | Worker `process-video` | ffprobe finds no video stream / cannot parse the input. Permanent, no retry |
| PROCESSING_ERROR | Worker `process-video` / sweep | Transient failure on the final attempt, source object missing, or the sweep finds the job in BullMQ `failed` while the row is still `processing` |

### Events/Messages

**Transport:** BullMQ on Redis via `@nestjs/bullmq` (per `phase-03-videos/TD-01`). A shared `QueueModule` holds `BullModule.forRootAsync` (connection `{ host: REDIS_HOST, port: REDIS_PORT }`, `prefix: QUEUE_PREFIX`, from the `queue` `registerAs` namespace) and registers the queues `video-processing` and `video-maintenance`. `AppModule` (API, producer only) and `WorkerModule` (worker) both import it. `@Processor` classes are registered **only** in `WorkerModule`, which bootstraps from `src/worker.ts` via `NestFactory.createApplicationContext(WorkerModule)` with shutdown hooks enabled and no HTTP listener (per `phase-03-videos/TD-02`). `WorkerModule` imports no HTTP-only module (no controllers, no `AuthModule`, no throttler).

#### process-video

**Queue / job name:** `video-processing` / `process-video`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options (constants in code, not env):**

```ts
{
  jobId: videoId,                              // idempotent enqueue / dedup
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 }, // retries after 5 s, then 10 s
  removeOnComplete: true,
  removeOnFail: { count: 1000 },               // keep recent failures for inspection
}
```

Adding a job whose `jobId` is already in the queue (waiting/active/delayed/**failed**) is a no-op. That is why the sweep checks the job state instead of blindly re-adding.

**Producer:** `POST /videos/:id/upload/complete` after the DB commit (API, `@InjectQueue('video-processing')`), and the maintenance sweep (worker) for orphaned `processing` rows (per `phase-03-videos/TD-01`, `phase-03-videos/TD-12`).
**Consumer:** `VideoProcessingConsumer` — `@Processor('video-processing', { concurrency: 2 })`, extends `WorkerHost`, in `WorkerModule` (per `phase-03-videos/TD-02`).
**Trigger:** the upload completed and the video moved `uploading → processing`.
**Delivery semantics:** at-least-once; the consumer is idempotent: re-running overwrites metadata, `thumbnail_key` object and status (per `phase-03-videos/TD-12`).

**Processing steps:**
1. Load the `Video` by `videoId`. If it is missing, or `processing_status` is `uploading`/`failed`, complete the job as a no-op (logged). `processing` and `ready` proceed (`ready` = idempotent re-run).
2. `HeadObject` on `source_key` (internal client). `NotFound` → **permanent** (`PROCESSING_ERROR`). Any other S3 error → transient.
3. Presign a GET for `source_key` with the **internal** client (`S3_ENDPOINT`), TTL 3600 s (constant, it must outlive the job), and pass it as `-i` (per `phase-03-videos/TD-04`; ffprobe/ffmpeg read only what they need via HTTP Range).
4. ffprobe through the typed `execFile` wrapper (no shell; `-v error -print_format json -show_format -show_streams <url>`, timeout 120 s) (per `phase-03-videos/TD-03`). Map `format.duration`, `format.format_name`, and the first video stream's `width`/`height`/`codec_name` plus the first audio stream's `codec_name`.
5. Thumbnail: `ffmpeg -ss <t> -i <url> -frames:v 1 <tmp>.jpg`, with `t = min(duration × 0.1, 10)` seconds (`0` when duration is unknown or < 1 s) — the frame policy parameter of `phase-03-videos/TD-03`. The temp file goes in `os.tmpdir()` and is removed in `finally`. `PutObject` to `S3_THUMBNAILS_BUCKET` key `{id}/default.jpg`, `ContentType: image/jpeg`.
6. Update the row: metadata columns, `thumbnail_key`, `processing_status = 'ready'`, `processed_at = now()`, `failure_reason = null`.

**Error classification:**

| Class | Examples | Handling |
|-------|----------|----------|
| Permanent | ffprobe exits non-zero with an input-parse marker in stderr (`Invalid data found when processing input`, `moov atom not found`); ffprobe JSON has **no video stream**; source object `NotFound` | Set `processing_status = 'failed'` with `failure_reason = 'INVALID_MEDIA'` (or `PROCESSING_ERROR` for a missing source), then throw BullMQ `UnrecoverableError`, so the job goes to `failed` with no retry regardless of `attempts` (bullmq v6, "stop-retrying-jobs") |
| Transient | S3/network errors, ffmpeg/ffprobe timeouts, other non-zero exits, DB errors | Rethrow, and BullMQ retries with exponential backoff. **On the final attempt** (`job.attemptsStarted >= (job.opts.attempts ?? 1)`, where `attemptsStarted` already counts the current attempt per the bullmq v6 docs), first set `failed` + `PROCESSING_ERROR`, then rethrow |

Unknown errors default to **transient**, which is bounded by `attempts` and ends in `PROCESSING_ERROR`. Status writes in the consumer are conditional (`WHERE id = :id AND processing_status IN ('processing','ready')`), so they never resurrect a row that the sweep or the API already moved.

#### video-maintenance sweep

**Queue / scheduler:** `video-maintenance`. Job Scheduler id `video-maintenance-sweep`, repeat `{ every: VIDEO_SWEEP_INTERVAL_MS }`, job template `{ name: 'sweep', data: {}, opts: { attempts: 1 } }` (per `phase-03-videos/TD-12`). bullmq v6 has no legacy `repeat` API, so `upsertJobScheduler` is the only path (`library-refs.md` → bullmq).

**Payload:**

```json
{}
```

**Producer:** `WorkerModule` on bootstrap (`onApplicationBootstrap`) calls `queue.upsertJobScheduler('video-maintenance-sweep', { every: VIDEO_SWEEP_INTERVAL_MS }, { name: 'sweep', data: {}, opts: { attempts: 1 } })`. This is idempotent by scheduler id, so restarts and extra replicas do not stack schedulers. The API never declares it.
**Consumer:** `VideoMaintenanceConsumer` — `@Processor('video-maintenance', { concurrency: 1 })`, extends `WorkerHost`, in `WorkerModule`. Each tick is one job handled by one worker.
**Trigger:** every `VIDEO_SWEEP_INTERVAL_MS` (default 900000 = 15 min).
**Delivery semantics:** best-effort per tick (`attempts: 1`). A failed tick is simply covered by the next one. Per-row errors are logged and do not abort the batch.

**What a tick does** (batches of at most 100 rows per category, oldest first):
1. **Stale uploads.** Select `processing_status = 'uploading' AND updated_at < now() - VIDEO_UPLOAD_STALE_AFTER_MS` (default 86400000 = 24 h of no upload activity; `part-urls` bumps `updated_at`). For each row, claim it with a conditional update (`WHERE id = :id AND processing_status = 'uploading'`) to `failed`, `failure_reason = 'UPLOAD_ABANDONED'`, `upload_id = null`. Only when the claim affected 1 row, call `AbortMultipartUpload` with the previous `upload_id` (`NoSuchUpload` tolerated). A concurrent `complete` loses the race cleanly, because its own transition to `processing` is conditional on `uploading` and answers `INVALID_VIDEO_STATE`.
2. **Orphaned processing.** Select `processing_status = 'processing' AND updated_at < now() - VIDEO_SWEEP_INTERVAL_MS` (one tick of grace, so the API's post-commit enqueue is not raced). For each row, `getJob(videoId)` on `video-processing`:
   - missing → re-add `process-video` with the job options above (recovers the non-transactional enqueue, per `phase-03-videos/TD-01`);
   - state `failed` → conditional update to `failed` + `PROCESSING_ERROR`;
   - waiting / active / delayed → leave it alone.

**Backstops, not substitutes:** MinIO `stale_uploads_expiry` (24 h default) and S3 `AbortIncompleteMultipartUpload` only clean storage. Neither updates the DB row (per `phase-03-videos/TD-12`).

**Testability:** integration tests call `VideoMaintenanceConsumer.process()` / `VideoProcessingConsumer.process()` directly against real Postgres + MinIO (+ real ffprobe for processing), with no waiting on ticks. e2e boots the HTTP app **and** `WorkerModule` in the same Jest process and polls `GET /videos/:id` until `ready` (with a timeout) (per `phase-03-videos/TD-14`).

### Configuration & Infrastructure

New env keys, validated by `src/config/env.validation.ts` (Joi, inherited convention), exposed through new `registerAs` namespaces loaded by **both** `AppModule` and `WorkerModule`, and listed in `.env.example` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`, `phase-03-videos/TD-12`, `phase-03-videos/TD-13`, `phase-03-videos/TD-16`):

| Key | Namespace (`src/config/…`) | Joi rule | Default | `.env.example` |
|-----|---------------------------|----------|---------|----------------|
| REDIS_HOST | `queue.config.ts` | string | `redis` | `redis` |
| REDIS_PORT | `queue.config.ts` | number, port | `6379` | `6379` |
| QUEUE_PREFIX | `queue.config.ts` | string | `bull` | `bull` (test runs use a test prefix, per TD-14) |
| S3_ENDPOINT | `storage.config.ts` | string, uri, required | — | `http://minio:9000` |
| S3_PUBLIC_ENDPOINT | `storage.config.ts` | string, uri, required | — | `http://minio.localhost:9000` |
| S3_REGION | `storage.config.ts` | string | `us-east-1` | `us-east-1` |
| S3_ACCESS_KEY | `storage.config.ts` | string, required | — | `streamtube` |
| S3_SECRET_KEY | `storage.config.ts` | string, required, min 8 | — | `streamtube-secret` |
| S3_VIDEOS_BUCKET | `storage.config.ts` | string | `videos` | `videos` |
| S3_THUMBNAILS_BUCKET | `storage.config.ts` | string | `thumbnails` | `thumbnails` |
| VIDEO_MAX_UPLOAD_BYTES | `video.config.ts` | number, integer, min 1 | `10737418240` (10 GiB) | `10737418240` |
| VIDEO_UPLOAD_PART_SIZE_BYTES | `video.config.ts` | number, integer, min `5242880`, max `5368709120` | `67108864` (64 MiB) | `67108864` |
| VIDEO_UPLOAD_PART_URL_TTL_SECONDS | `video.config.ts` | number, integer, min 60, max 604800 | `3600` | `3600` |
| VIDEO_PLAYBACK_URL_TTL_SECONDS | `video.config.ts` | number, integer, min 60, max 604800 | `14400` (4 h, outlasts a viewing session) | `14400` |
| VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL | `video.config.ts` | number, integer, min 1 | `5` | `5` |
| VIDEO_SWEEP_INTERVAL_MS | `video.config.ts` | number, integer, min 1000 | `900000` | `900000` |
| VIDEO_UPLOAD_STALE_AFTER_MS | `video.config.ts` | number, integer, min 60000 | `86400000` | `86400000` |

Tests reuse the production code path with small values, e.g. `VIDEO_MAX_UPLOAD_BYTES=12582912` (12 MiB) and `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` (5 MiB), plus test-scoped buckets and queue prefix (per `phase-03-videos/TD-06`, `phase-03-videos/TD-14`). The override mechanism (env set before module compile vs config provider override) is an SI-level choice.

**Compose (`nestjs-project/compose.yaml`)** — host keys use service names, with the single exception below (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`, `phase-03-videos/TD-14`, `phase-03-videos/TD-16`):
- `Dockerfile.dev`: `apt install -y … ffmpeg` (provides `ffprobe`). Shared by `nestjs-api` and `video-worker`, so it needs a one-time `docker compose build`.
- `redis`: `redis:8-alpine`, `redis-server --maxmemory-policy noeviction`, port `6379`, healthcheck `redis-cli ping`.
- `minio`: `cgr.dev/chainguard/minio@sha256:<digest>` (digest pinned at implementation), `server /data --address :9000 --console-address :9001`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` equal to `S3_ACCESS_KEY`/`S3_SECRET_KEY`, ports `9000:9000` (same port inside and out) + `9001:9001`, named volume, network alias **`minio.localhost`**, readiness healthcheck (probe command validated against the pinned image).
- `minio-init`: one-shot `cgr.dev/chainguard/minio-client@sha256:<digest>` that creates `videos`, `thumbnails` and the test buckets idempotently, sets anonymous download on the thumbnails buckets, and configures CORS exposing `ETag` for browser PUT/GET (mechanism verified against the pinned image). Depends on `minio` healthy.
- `video-worker`: same build/volume as `nestjs-api`, `command` runs the worker entrypoint, `depends_on` `db`/`redis`/`minio` healthy + `minio-init` completed successfully.
- `nestjs-api`: `depends_on` gains `redis`, `minio` (healthy) and `minio-init` (completed successfully). DoD commands stay unchanged (`docker compose exec nestjs-api …`).

**Docker Networking exception to record in root `CLAUDE.md`** (per `phase-03-videos/TD-16`): `S3_PUBLIC_ENDPOINT` is the one key allowed a `*.localhost` host (`http://minio.localhost:9000`). Inside containers it is a Compose network alias of the storage service, resolved by Docker DNS to that service and never to the container's own loopback, so the rule's intent (never point a container at itself) holds. It exists only because presigned URLs must be signed for a host that is also valid in the browser. Every other host key (`DB_HOST`, `REDIS_HOST`, `S3_ENDPOINT`) keeps the service name.

**Other doc/test fallout to cover in SIs:** `nestjs-project/CLAUDE.md` (services list, `redis-cli ping` + MinIO readiness probes, rebuild after `Dockerfile.dev` changes, worker entrypoint), and `test:e2e` in `package.json` gaining `--runInBand` (CLAUDE.md claims it is already configured, but the script lacks it).

---

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
