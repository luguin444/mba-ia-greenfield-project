---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/upload/complete — Test Plan

## Application Overview

`POST /videos/:id/upload/complete` fecha o upload multipart: confere dono e estado `uploading`, lista as partes no storage, rejeita partes faltando (`409 UPLOAD_INCOMPLETE`, vídeo segue retomável) ou soma divergente do `sizeBytes` declarado (`422 UPLOAD_SIZE_MISMATCH`, vídeo segue `uploading`), completa o multipart com as partes ordenadas, faz o backstop de `HeadObject`, move o vídeo para `processing` e, após o commit, enfileira o job `process-video` com `jobId = videoId`. Falha no enqueue é logada em nível `error` e engolida: a resposta continua `202`. Não-dono recebe `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Completar upload e enfileirar processamento

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); ambiente de teste via `src/test/setup-test-env.ts` (fila de prefixo `test`, bucket `videos-test`, parte `5242880`); obter a fila com `moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE))`. Nenhum `WorkerModule` sobe nesta suíte, então o job fica na fila. `beforeEach`: `cleanAllTables`, limpar o `ThrottlerStorage`, registrar e confirmar dono e outro usuário (cada um com canal), obter os `access_token` via `POST /auth/login`. Partes são enviadas por PUT direto nas URLs pré-assinadas. `afterEach`: `jest.restoreAllMocks()`. `afterAll`: `obliterateTestQueues` e `app.close()`.

#### 1.1. todas-as-partes-enviadas-retorna-202-e-enfileira-job

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Dono inicia upload com `{ fileName: "clip.mp4", sizeBytes: 10485760, mimeType: "video/mp4" }` (2 partes) e faz PUT de 5 MiB na parte 2 e depois na parte 1 (ordem invertida)
  2. POST /videos/:id/upload/complete com o token do dono, sem body
    - expect: status `202`
    - expect: corpo `VideoResponse` com `id = videoId`, `processingStatus: "processing"`, `publicationStatus: "draft"`, `failureReason: null`, `fileName: "clip.mp4"`, `mimeType: "video/mp4"`, `sizeBytes: 10485760`
    - expect: `durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `formatName`, `thumbnailUrl` e `processedAt` são `null`; `createdAt`/`updatedAt` são ISO-8601
  3. Ler a linha do vídeo
    - expect: `processing_status = 'processing'` e `upload_id` nulo
  4. `queue.getJob(videoId)` na fila `video-processing` de prefixo `test`
    - expect: o job existe, com nome `process-video` e `data = { videoId }`

#### 1.2. segundo-complete-retorna-409-invalid-video-state

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Repetir os passos 1–2 do cenário 1.1 até receber `202`
  2. POST /videos/:id/upload/complete de novo, com o token do dono
    - expect: status `409` com `{ statusCode: 409, error: "INVALID_VIDEO_STATE", message: "Operation not allowed in the current video state" }`
    - expect: a linha continua `processing`

#### 1.3. falha-no-enqueue-ainda-retorna-202-e-loga-erro

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Dono inicia upload de `sizeBytes: 1048576` (1 parte) e faz PUT de 1 MiB na parte 1
  2. Simular o Redis indisponível: `jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('connect ECONNREFUSED'))` e `jest.spyOn(Logger.prototype, 'error')`
  3. POST /videos/:id/upload/complete com o token do dono
    - expect: status `202` com `processingStatus: "processing"`
    - expect: a linha do vídeo está `processing` com `upload_id` nulo (estado commitado, re-enfileirável pela varredura)
    - expect: `Logger.prototype.error` foi chamado com uma mensagem que contém o `videoId`

### 2. Upload incompleto ou com tamanho divergente

**Setup:** mesmo do grupo 1.

#### 2.1. partes-faltando-retorna-409-upload-incomplete-e-segue-retomavel

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Dono inicia upload de `sizeBytes: 10485760` (2 partes) e faz PUT só da parte 1
  2. POST /videos/:id/upload/complete com o token do dono
    - expect: status `409` com `error: "UPLOAD_INCOMPLETE"` e `message: "Upload is missing parts: 2"`
  3. Ler a linha do vídeo
    - expect: `processing_status = 'uploading'` e `upload_id` inalterado
  4. POST /videos/:id/upload/part-urls com o token do dono
    - expect: status `200` com `parts` contendo a parte 2 (upload retomável)

#### 2.2. soma-das-partes-divergente-retorna-422

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Dono inicia upload de `sizeBytes: 2048` (1 parte) e faz PUT de apenas 1024 bytes na parte 1
  2. POST /videos/:id/upload/complete com o token do dono
    - expect: status `422` com `{ statusCode: 422, error: "UPLOAD_SIZE_MISMATCH", message: "Uploaded size does not match the declared size" }`
  3. Ler a linha do vídeo e a fila
    - expect: `processing_status = 'uploading'`, `failure_reason` nulo, `upload_id` inalterado
    - expect: `queue.getJob(videoId)` não retorna job

### 3. Autorização e validação (hide, don't forbid)

**Setup:** mesmo do grupo 1, com um vídeo do dono em `uploading` e todas as partes enviadas.

#### 3.1. nao-dono-e-id-inexistente-recebem-404-identico

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/:id/upload/complete com o token do outro usuário
    - expect: status `404` com `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`, nunca `403`
  2. POST /videos/<uuid aleatório inexistente>/upload/complete com o token do dono
    - expect: status `404` com corpo **idêntico** (deep equal) ao do passo 1
  3. Ler a linha do vídeo e a fila
    - expect: o vídeo continua `uploading` e nenhum job foi enfileirado

#### 3.2. sem-token-401-e-id-invalido-400

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/:id/upload/complete sem header `Authorization`
    - expect: status `401`
  2. POST /videos/:id/upload/complete com token do dono expirado (criado com `jwtService.sign(payload, { expiresIn: -60 })`, nunca com `exp` no payload)
    - expect: status `401`
  3. POST /videos/not-a-uuid/upload/complete com o token do dono
    - expect: status `400` com `error: "VALIDATION_ERROR"`
