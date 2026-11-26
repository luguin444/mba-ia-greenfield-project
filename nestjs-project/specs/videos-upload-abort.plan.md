---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos-upload-abort.e2e-spec.ts
---

# DELETE /videos/:id/upload — Test Plan

## Application Overview

`DELETE /videos/:id/upload` permite ao dono abortar um upload em andamento: confere dono e estado `uploading`, aborta o multipart no storage (tolerando `NoSuchUpload`) e marca o vídeo como `failed` com `failure_reason = 'UPLOAD_ABORTED'` e `upload_id` nulo. Isso libera um slot do teto de uploads ativos do canal e o espaço das partes no storage. Não-dono recebe `404 VIDEO_NOT_FOUND`, idêntico ao de um vídeo inexistente.

## Test Scenarios

### 1. Abortar upload em andamento

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); ambiente de teste via `src/test/setup-test-env.ts`. `beforeEach`: `cleanAllTables`, limpar o `ThrottlerStorage`, registrar e confirmar dono e outro usuário (cada um com canal), obter os `access_token` via `POST /auth/login`; o dono inicia um upload com `sizeBytes: 10485760` e guarda `videoId` e `parts[0].url`. `afterAll`: `obliterateTestQueues` e `app.close()`.

#### 1.1. dono-aborta-e-recebe-204

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. DELETE /videos/:id/upload com o token do dono
    - expect: status `204` com corpo vazio
  2. Ler a linha do vídeo
    - expect: `processing_status = 'failed'`, `failure_reason = 'UPLOAD_ABORTED'`, `upload_id` nulo
  3. PUT de 5 MiB em `parts[0].url` (guardada antes do abort), direto no storage
    - expect: o storage responde `404` (`NoSuchUpload`), pois o multipart foi abortado

#### 1.2. abort-libera-slot-do-teto-de-uploads-ativos

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Dono inicia mais uploads até o canal ter `VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL` (5) vídeos `uploading`
  2. POST /videos/uploads com o token do dono
    - expect: status `409` `ACTIVE_UPLOAD_LIMIT_REACHED`
  3. DELETE /videos/:id/upload de um dos vídeos, com o token do dono
    - expect: status `204`
  4. POST /videos/uploads com o token do dono
    - expect: status `201`

### 2. Estado inválido

**Setup:** mesmo do grupo 1.

#### 2.1. repetir-delete-ou-video-fora-de-uploading-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. DELETE /videos/:id/upload com o token do dono
    - expect: status `204`
  2. DELETE /videos/:id/upload de novo, no mesmo vídeo
    - expect: status `409` com `{ statusCode: 409, error: "INVALID_VIDEO_STATE", message: "Operation not allowed in the current video state" }`
  3. Em outro vídeo do dono, atualizar a linha no banco para `processing_status = 'processing'` e chamar DELETE /videos/:id/upload
    - expect: status `409` `INVALID_VIDEO_STATE`, e a linha continua `processing`

### 3. Autorização e validação (hide, don't forbid)

**Setup:** mesmo do grupo 1.

#### 3.1. nao-dono-e-id-inexistente-recebem-404-identico

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. DELETE /videos/:id/upload com o token do outro usuário
    - expect: status `404` com `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`, nunca `403`
  2. DELETE /videos/<uuid aleatório inexistente>/upload com o token do dono
    - expect: status `404` com corpo **idêntico** (deep equal) ao do passo 1
  3. Ler a linha do vídeo
    - expect: continua `uploading` com `upload_id` preenchido (a chamada do não-dono não teve efeito)

#### 3.2. sem-token-401-e-id-invalido-400

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. DELETE /videos/:id/upload sem header `Authorization`
    - expect: status `401`
  2. DELETE /videos/:id/upload com token do dono expirado (criado com `jwtService.sign(payload, { expiresIn: -60 })`, nunca com `exp` no payload)
    - expect: status `401`
  3. DELETE /videos/not-a-uuid/upload com o token do dono
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  4. Ler a linha do vídeo
    - expect: continua `uploading`
