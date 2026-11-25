---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-upload-part-urls.e2e-spec.ts
---

# POST /videos/:id/upload/part-urls — Test Plan

## Application Overview

`POST /videos/:id/upload/part-urls` é o caminho de retomada do upload: confere que o caller é o dono e que o vídeo está `uploading`, consulta no storage (`ListParts`) as partes já gravadas e assina as faltantes (ou exatamente as `partNumbers` pedidas, permitindo re-PUT). Também avança o `updated_at`, que a varredura de manutenção lê como "última atividade". Não-dono recebe `404 VIDEO_NOT_FOUND`, idêntico ao de um vídeo inexistente (hide, don't forbid).

## Test Scenarios

### 1. Retomar upload e assinar partes

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduzindo o `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform` + `DomainExceptionFilter` + `ValidationExceptionFilter`); ambiente de teste via `src/test/setup-test-env.ts` (bucket `videos-test`, parte `5242880`). `beforeEach`: `cleanAllTables`, limpar o `ThrottlerStorage`, registrar e confirmar dono e outro usuário (cada um com canal), obter os `access_token` via `POST /auth/login`; o dono inicia um upload com `sizeBytes: 10485760` (2 partes de 5 MiB) e faz PUT de 5 MiB em `parts[0].url` direto no storage. `afterAll`: `obliterateTestQueues` e `app.close()`.

#### 1.1. retomada-sem-body-assina-as-faltantes-e-avanca-updated-at

**Covers AC:** #1, #7
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Ler o `updated_at` da linha do vídeo no banco
  2. POST /videos/:id/upload/part-urls com o token do dono e sem body
    - expect: status `200`
    - expect: `videoId` e `uploadId` iguais aos da iniciação, `partSize = 5242880`, `partCount = 2`
    - expect: `uploadedParts` = `[{ partNumber: 1, size: 5242880, etag: <string não vazia> }]`
    - expect: `parts` = um único item com `partNumber: 2` e `url` assinada para o host `minio.localhost:9000`
    - expect: `expiresAt` é ISO-8601 no futuro
  3. Ler de novo o `updated_at` da linha
    - expect: é posterior ao valor lido no passo 1

#### 1.2. partnumbers-explicitos-reassinam-parte-ja-enviada

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com o token do dono e body `{ partNumbers: [1] }`
    - expect: status `200`, com `parts` contendo exatamente um item `partNumber: 1`
    - expect: `uploadedParts` continua listando a parte 1
  2. PUT de 5 MiB na `url` devolvida, direto no storage
    - expect: status `200` com `ETag` (re-PUT sobrescreve a parte)

### 2. Erros de entrada e de estado

**Setup:** mesmo do grupo 1.

#### 2.1. part-number-maior-que-part-count-retorna-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com o token do dono e `{ partNumbers: [3] }` (`partCount = 2`)
    - expect: status `400` com `{ statusCode: 400, error: "INVALID_PART_NUMBER", message: "Part number out of range" }`

#### 2.2. id-ou-body-invalido-retorna-400-validation-error

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/not-a-uuid/upload/part-urls com o token do dono
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  2. POST /videos/:id/upload/part-urls com o token do dono e, em chamadas separadas, `{ partNumbers: [] }`, `{ partNumbers: [1, 1] }`, `{ partNumbers: [0] }` e `{ foo: 1 }`
    - expect: status `400` `VALIDATION_ERROR` em todas

#### 2.3. video-fora-de-uploading-retorna-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. Atualizar a linha do vídeo no banco para `processing_status = 'processing'` e `upload_id = null`
  2. POST /videos/:id/upload/part-urls com o token do dono
    - expect: status `409` com `{ statusCode: 409, error: "INVALID_VIDEO_STATE", message: "Operation not allowed in the current video state" }`

### 3. Autorização (hide, don't forbid)

**Setup:** mesmo do grupo 1.

#### 3.1. nao-dono-e-id-inexistente-recebem-404-identico

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com o token do outro usuário (vídeo existe, é do dono)
    - expect: status `404` com `{ statusCode: 404, error: "VIDEO_NOT_FOUND", message: "Video not found" }`
    - expect: nunca `403`
  2. POST /videos/<uuid aleatório inexistente>/upload/part-urls com o token do dono
    - expect: status `404` com corpo **idêntico** (deep equal) ao do passo 1
  3. Ler a linha do vídeo
    - expect: `updated_at` não mudou com a chamada do não-dono

#### 3.2. sem-token-ou-token-expirado-retorna-401

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-25T01:35:27Z

**Steps:**
  1. POST /videos/:id/upload/part-urls sem header `Authorization`
    - expect: status `401`
  2. POST /videos/:id/upload/part-urls com token do dono expirado (criado com `jwtService.sign(payload, { expiresIn: -60 })`, nunca com `exp` no payload)
    - expect: status `401`
