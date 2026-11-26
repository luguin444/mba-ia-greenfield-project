---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: test/videos-playback.e2e-spec.ts
---

# GET /videos/:publicId/playback — Test Plan

## Application Overview

`GET /videos/:publicId/playback` emite uma URL pré-assinada de curta duração (cliente S3 público, host `minio.localhost`) para o `<video>` fazer Range/206 direto no storage. A rota é `@OptionalAuth()`: sem `Authorization` o caller é anônimo; com token válido o handler sabe quem é o dono; com token inválido/expirado responde `401` (para o BFF disparar o refresh), nunca degrada para anônimo. Visível = dono **ou** `publication_status ≠ 'draft'`; na Fase 03 todo vídeo é `draft`, então só o dono recebe URL. Não visível, inexistente ou `publicId` malformado → `404 VIDEO_NOT_FOUND` idêntico; visível mas não `ready` → `409 VIDEO_NOT_READY`. A resposta leva `Cache-Control: no-store`.

## Test Scenarios

### 1. Acesso por visibilidade (os 4 casos de optional-auth)

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); ambiente de teste via `src/test/setup-test-env.ts` (bucket `videos-test`). `beforeEach`: `cleanAllTables`, limpar o `ThrottlerStorage`, registrar e confirmar dono e outro usuário (cada um com canal), obter os `access_token` via `POST /auth/login`. Vídeo `ready` do dono: iniciar upload de `sizeBytes: 1048576`, PUT de 1 MiB na parte 1, `POST /videos/:id/upload/complete` (`202`) e, simulando o worker (que não sobe nesta suíte), atualizar a linha para `processing_status = 'ready'` e `processed_at = now()`. Guardar o `publicId`. `afterAll`: `obliterateTestQueues` e `app.close()`.

#### 1.1. dono-com-video-ready-recebe-url-que-responde-206

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/:publicId/playback com o token do dono
    - expect: status `200` com corpo contendo exatamente `url` e `expiresAt`
    - expect: header `Cache-Control: no-store`
    - expect: `url` com host `minio.localhost:9000`, caminho `/videos-test/{videoId}/source` e parâmetros de assinatura (`X-Amz-Signature`, `X-Amz-Expires=14400`)
    - expect: `expiresAt` ISO-8601 ~ agora + `VIDEO_PLAYBACK_URL_TTL_SECONDS`
  2. GET na `url` com header `Range: bytes=0-1023`, direto no storage
    - expect: status `206`, `Content-Range: bytes 0-1023/1048576` e corpo de 1024 bytes

#### 1.2. anonimo-em-rascunho-recebe-404-identico-a-inexistente

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/:publicId/playback sem header `Authorization`
    - expect: status `404` com `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`, nunca `403`
  2. GET /videos/<publicId bem formado e inexistente, ex.: gerado por `generatePublicId()`>/playback sem `Authorization`
    - expect: status `404` com corpo **idêntico** (deep equal) ao do passo 1

#### 1.3. nao-dono-em-rascunho-recebe-404-identico

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/:publicId/playback com o token do outro usuário
    - expect: status `404` `VIDEO_NOT_FOUND`, com corpo idêntico ao de um `publicId` inexistente

#### 1.4. token-expirado-ou-invalido-recebe-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/:publicId/playback com `Authorization: Bearer <token do dono expirado, criado com `jwtService.sign(payload, { expiresIn: -60 })`, nunca com `exp` no payload>`
    - expect: status `401` (não `404` e não tratado como anônimo)
  2. GET /videos/:publicId/playback com `Authorization: Bearer not-a-jwt`
    - expect: status `401`

### 2. Estado do vídeo e formato do publicId

**Setup:** mesmo do grupo 1.

#### 2.1. publicid-malformado-recebe-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/abc12/playback (5 caracteres) com o token do dono
    - expect: status `404` `VIDEO_NOT_FOUND`, com corpo idêntico ao de um `publicId` inexistente (não `400`)
  2. GET /videos/abcdefghijkl/playback (12 caracteres) sem `Authorization`
    - expect: status `404` `VIDEO_NOT_FOUND`

#### 2.2. dono-com-video-nao-ready-recebe-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Dono inicia outro upload, envia a parte e chama `complete` (vídeo fica `processing`, sem simular o worker)
  2. GET /videos/:publicId/playback desse vídeo com o token do dono
    - expect: status `409` com `{ statusCode: 409, error: "VIDEO_NOT_READY", message: "Video is not ready for playback" }`
  3. GET /videos/:publicId/playback de um vídeo do dono ainda em `uploading`, com o token do dono
    - expect: status `409` `VIDEO_NOT_READY`
  4. GET /videos/:publicId/playback do vídeo `processing` com o token do outro usuário
    - expect: status `404` `VIDEO_NOT_FOUND` (a visibilidade é decidida antes do estado)
