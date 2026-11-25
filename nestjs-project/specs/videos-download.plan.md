---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.15
target_file: test/videos-download.e2e-spec.ts
---

# GET /videos/:publicId/download — Test Plan

## Application Overview

`GET /videos/:publicId/download` emite a URL pré-assinada de download do arquivo original, com `ResponseContentDisposition: attachment; filename="<nome ASCII sanitizado>"; filename*=UTF-8''<nome original em RFC 5987>`. Reaproveita a regra de visibilidade da playback: rota `@OptionalAuth()`, só o dono recebe URL enquanto o vídeo é `draft`, anônimo/não-dono/inexistente/`publicId` malformado → `404 VIDEO_NOT_FOUND` idêntico, dono com vídeo não `ready` → `409 VIDEO_NOT_READY`, token inválido/expirado → `401`. A resposta leva `Cache-Control: no-store`.

## Test Scenarios

### 1. Download pelo dono

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); ambiente de teste via `src/test/setup-test-env.ts` (bucket `videos-test`). `beforeEach`: `cleanAllTables`, limpar o `ThrottlerStorage`, registrar e confirmar dono e outro usuário (cada um com canal), obter os `access_token` via `POST /auth/login`. Vídeo `ready` do dono (helper do arquivo, parametrizado pelo `fileName`): iniciar upload de `sizeBytes: 1048576`, PUT de 1 MiB na parte 1, `POST /videos/:id/upload/complete` (`202`) e, simulando o worker (que não sobe nesta suíte), atualizar a linha para `processing_status = 'ready'` e `processed_at = now()`. `afterAll`: `obliterateTestQueues` e `app.close()`.

#### 1.1. dono-com-video-ready-baixa-com-attachment

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Dono prepara um vídeo `ready` com `fileName: "meu-video.mp4"`
  2. GET /videos/:publicId/download com o token do dono
    - expect: status `200` com corpo contendo exatamente `url` e `expiresAt`
    - expect: header `Cache-Control: no-store`
    - expect: `url` com host `minio.localhost:9000`, caminho `/videos-test/{videoId}/source` e assinatura
  3. GET na `url`, direto no storage
    - expect: status `200` com `Content-Disposition` começando por `attachment;` e contendo `filename="meu-video.mp4"` e `filename*=UTF-8''meu-video.mp4`
    - expect: corpo de 1048576 bytes (o tamanho declarado no upload)

#### 1.2. nome-com-acentos-gera-filename-ascii-e-filename-estrela-utf8

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Dono prepara um vídeo `ready` com `fileName: "Férias em São Paulo 🎬.mp4"`
  2. GET /videos/:publicId/download com o token do dono e depois GET na `url` devolvida
    - expect: o valor de `filename="…"` em `Content-Disposition` só tem caracteres ASCII imprimíveis e termina em `.mp4`
    - expect: `filename*=UTF-8''…` decodificado (`decodeURIComponent`) é igual a `"Férias em São Paulo 🎬.mp4"`

### 2. Visibilidade e estado (os 4 casos de optional-auth)

**Setup:** mesmo do grupo 1, com um vídeo `ready` do dono.

#### 2.1. anonimo-e-nao-dono-em-rascunho-recebem-404-identico

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/:publicId/download sem header `Authorization`
    - expect: status `404` com `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`, nunca `403`
  2. GET /videos/:publicId/download com o token do outro usuário
    - expect: status `404` com corpo idêntico ao do passo 1
  3. GET /videos/<publicId bem formado e inexistente>/download sem `Authorization`
    - expect: status `404` com corpo idêntico ao do passo 1
  4. GET /videos/abc12/download (`publicId` malformado) com o token do dono
    - expect: status `404` `VIDEO_NOT_FOUND`

#### 2.2. token-expirado-recebe-401

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. GET /videos/:publicId/download com `Authorization: Bearer <token do dono assinado com o mesmo segredo e exp no passado>`
    - expect: status `401` (não `404` e não tratado como anônimo)

#### 2.3. dono-com-video-nao-ready-recebe-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Dono inicia outro upload, envia a parte e chama `complete` (vídeo fica `processing`, sem simular o worker)
  2. GET /videos/:publicId/download desse vídeo com o token do dono
    - expect: status `409` com `{ statusCode: 409, error: "VIDEO_NOT_READY", message: "Video is not ready for playback" }`
