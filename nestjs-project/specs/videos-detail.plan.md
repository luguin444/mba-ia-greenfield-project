---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-detail.e2e-spec.ts
---

# GET /videos/:id — Test Plan

## Application Overview

`GET /videos/:id` devolve ao dono o detalhe e o status atual do vídeo (`VideoResponse`), usado para acompanhar o processamento depois do `complete`. Quando há `thumbnail_key`, `thumbnailUrl` é a URL pública e sem assinatura do bucket de thumbnails (`{S3_PUBLIC_ENDPOINT}/{S3_THUMBNAILS_BUCKET}/{thumbnail_key}`); caso contrário é `null`. Rota exclusiva do dono: não-dono recebe `404 VIDEO_NOT_FOUND`, idêntico ao de um vídeo inexistente.

## Test Scenarios

### 1. Detalhe do vídeo para o dono

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); ambiente de teste via `src/test/setup-test-env.ts` (bucket de thumbnails `thumbnails-test`, público via `minio-init`). `beforeEach`: `cleanAllTables`, limpar o `ThrottlerStorage`, registrar e confirmar dono e outro usuário (cada um com canal), obter os `access_token` via `POST /auth/login`; o dono inicia um upload com `{ fileName: "clip.mp4", sizeBytes: 1048576, mimeType: "video/mp4" }`. `afterAll`: `obliterateTestQueues` e `app.close()`.

#### 1.1. dono-recebe-video-no-status-atual-com-metadados-nulos

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/:id com o token do dono
    - expect: status `200`
    - expect: `id = videoId`, `publicId` de 11 caracteres, `processingStatus: "uploading"`, `publicationStatus: "draft"`, `failureReason: null`, `fileName: "clip.mp4"`, `mimeType: "video/mp4"`, `sizeBytes: 1048576`
    - expect: `durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `formatName`, `thumbnailUrl` e `processedAt` são `null`; `createdAt`/`updatedAt` são ISO-8601
    - expect: o corpo não expõe campos internos (`uploadId`, `upload_id`, `sourceKey`, `source_key`, `channelId`, `channel_id`)

#### 1.2. thumbnail-preenchida-vira-url-publica-sem-assinatura

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Simular o resultado do worker: gravar um JPEG pequeno em `thumbnails-test` na chave `{videoId}/default.jpg` e atualizar a linha com `processing_status = 'ready'`, `thumbnail_key = '{videoId}/default.jpg'`, metadados (`duration_seconds`, `width`, `height`, `video_codec`, `format_name`) e `processed_at`
  2. GET /videos/:id com o token do dono
    - expect: status `200` com `processingStatus: "ready"`, metadados preenchidos e `processedAt` ISO-8601
    - expect: `thumbnailUrl = "http://minio.localhost:9000/thumbnails-test/{videoId}/default.jpg"`, sem query string de assinatura (`X-Amz-*`)
  3. GET anônimo em `thumbnailUrl`, direto no storage
    - expect: status `200` com `Content-Type: image/jpeg`

### 2. Autorização e validação (hide, don't forbid)

**Setup:** mesmo do grupo 1.

#### 2.1. nao-dono-e-id-inexistente-recebem-404-identico

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/:id com o token do outro usuário
    - expect: status `404` com `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`, nunca `403`
  2. GET /videos/<uuid aleatório inexistente> com o token do dono
    - expect: status `404` com corpo **idêntico** (deep equal) ao do passo 1

#### 2.2. sem-token-ou-token-expirado-retorna-401

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/:id sem header `Authorization`
    - expect: status `401`
  2. GET /videos/:id com token do dono expirado (`exp` no passado)
    - expect: status `401`

#### 2.3. id-que-nao-e-uuid-retorna-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/not-a-uuid com o token do dono
    - expect: status `400` com `error: "VALIDATION_ERROR"`
