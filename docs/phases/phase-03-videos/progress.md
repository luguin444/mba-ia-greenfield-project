# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/21 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Infra: isolamento do ambiente de teste e `--runInBand` no `test:e2e`
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Entidade `Video`, migration `CreateVideos` e ajustes nos testes existentes
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Módulo de storage (adapter S3 com client interno e público)
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
