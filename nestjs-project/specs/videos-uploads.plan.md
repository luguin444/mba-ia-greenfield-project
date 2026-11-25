---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-uploads.e2e-spec.ts
---

# POST /videos/uploads — Test Plan

## Application Overview

`POST /videos/uploads` inicia o upload de um vídeo: resolve o canal do caller pelo JWT, rejeita tamanhos acima de `VIDEO_MAX_UPLOAD_BYTES`, aplica o teto de uploads ativos por canal sob lock, abre o multipart no storage, pré-cadastra o vídeo como `uploading`/`draft` e devolve o primeiro lote (≤100) de URLs pré-assinadas de parte. Nenhum byte de vídeo passa pela API. A rota exige JWT, envia sempre para o canal do próprio caller e fica fora do throttler (`@SkipThrottle()`).

## Test Scenarios

### 1. Iniciar upload multipart

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`). O ambiente de teste vem de `src/test/setup-test-env.ts` (fila `test`, buckets `videos-test`/`thumbnails-test`, teto `12582912`, parte `5242880`). `beforeEach`: `cleanAllTables`, limpar o `ThrottlerStorage`, registrar e confirmar o dono (`owner@example.com`) e um segundo usuário (`other@example.com`), cada um com o próprio canal, e obter os `access_token` via `POST /auth/login`. `afterAll`: `obliterateTestQueues` e `app.close()`.

#### 1.1. inicia-upload-e-retorna-primeiro-lote-de-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/uploads com o token do dono e body `{ fileName: "clip.mp4", sizeBytes: 11534336, mimeType: "video/mp4" }`
    - expect: status `201`
    - expect: `videoId` é uuid, `publicId` casa `^[A-Za-z0-9_-]{11}$`, `uploadId` é string não vazia
    - expect: `partSize = 5242880` e `partCount = 3`
    - expect: `parts` tem 3 itens com `partNumber` `[1, 2, 3]` em ordem crescente, cada `url` com host `minio.localhost:9000` e caminho no bucket `videos-test` em `{videoId}/source`
    - expect: `expiresAt` é ISO-8601 no futuro (~ agora + `VIDEO_UPLOAD_PART_URL_TTL_SECONDS`)
  2. Consultar a linha `videos` com `id = videoId`
    - expect: `processing_status = 'uploading'`, `publication_status = 'draft'`, `upload_id = uploadId`, `channel_id` = canal do dono, `original_filename = 'clip.mp4'`, `size_bytes = 11534336`, `failure_reason` nulo
  3. PUT de 5 MiB em `parts[0].url` direto no storage (fora da API)
    - expect: status `200` com header `ETag`, provando que o multipart está aberto

#### 1.2. usuario-sem-canal-recebe-404-channel-not-found

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Remover a linha `channels` do dono direto no banco (estado defensivo do `### Error Catalog` → `CHANNEL_NOT_FOUND`)
  2. POST /videos/uploads com o token do dono e body válido
    - expect: status `404` com `{ statusCode: 404, error: "CHANNEL_NOT_FOUND", message: "Channel not found for the authenticated user" }`
    - expect: nenhuma linha criada em `videos`

### 2. Regras de domínio (tamanho e teto de uploads ativos)

**Setup:** mesmo do grupo 1.

#### 2.1. tamanho-acima-do-teto-retorna-413

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/uploads com o token do dono e `sizeBytes: 12582913` (teto de teste + 1)
    - expect: status `413` com `{ statusCode: 413, error: "VIDEO_TOO_LARGE", message: "Video exceeds the maximum upload size" }`
    - expect: nenhuma linha criada em `videos`
  2. POST /videos/uploads com `sizeBytes: 12582912` (exatamente o teto)
    - expect: status `201`

#### 2.2. canal-no-teto-de-uploads-ativos-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/uploads com o token do dono, body válido, `VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL` vezes (default `5`)
    - expect: todas retornam `201`
  2. Mais um POST /videos/uploads com o token do dono
    - expect: status `409` com `{ statusCode: 409, error: "ACTIVE_UPLOAD_LIMIT_REACHED", message: "Too many uploads in progress for this channel" }`
    - expect: o canal do dono continua com exatamente 5 vídeos `uploading`
  3. POST /videos/uploads com o token do outro usuário
    - expect: status `201` (o teto é por canal, não global)

### 3. Validação de entrada

**Setup:** mesmo do grupo 1.

#### 3.1. body-invalido-retorna-400-validation-error

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/uploads com o token do dono e `mimeType: "image/png"`
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `message` como array de strings
  2. POST /videos/uploads com body válido mais a chave desconhecida `channelId`
    - expect: status `400` `VALIDATION_ERROR` (`forbidNonWhitelisted`)
  3. POST /videos/uploads com `sizeBytes: 0` e, em outra chamada, com `fileName: ""`
    - expect: status `400` `VALIDATION_ERROR` nas duas (não `413`)
  4. Contar as linhas de `videos`
    - expect: nenhuma linha criada

### 4. Autenticação e throttling

**Setup:** mesmo do grupo 1.

#### 4.1. sem-token-ou-token-expirado-retorna-401

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/uploads com body válido e sem header `Authorization`
    - expect: status `401`
  2. POST /videos/uploads com `Authorization: Bearer <token do dono expirado, criado com `jwtService.sign(payload, { expiresIn: -60 })`, nunca com `exp` no payload>`
    - expect: status `401`
  3. Contar as linhas de `videos`
    - expect: nenhuma linha criada

#### 4.2. chamadas-em-sequencia-nunca-recebem-429

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Limpar o `ThrottlerStorage` e fazer 15 POST /videos/uploads seguidos com o token do dono e body válido (acima do limite global de 10/min)
    - expect: nenhuma resposta tem status `429`
    - expect: as 5 primeiras retornam `201` e as demais `409` `ACTIVE_UPLOAD_LIMIT_REACHED`
