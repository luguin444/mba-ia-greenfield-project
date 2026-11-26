---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-25T11:24:26-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-25T11:57:44-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-24T23:28:59-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-28T19:33:34-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of up to 10GB straight to object storage (S3 multipart via presigned URLs, with the video pre-registered as a draft when the upload starts), automatic background processing through a queue and an FFmpeg worker (duration/metadata extraction and a thumbnail from one frame), a unique short URL per video, and streaming playback (HTTP Range/206) plus download served from storage — making "upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas" true end to end in `nestjs-project`.

---

## Step Implementations

### SI-03.1 — Infra: dependências, namespaces de configuração e variáveis de ambiente

**Description:** Instala as libs de fila e de storage e cria os namespaces `queue`, `storage` e `video` (registerAs + Joi + `.env.example`). É a base de configuração que todo o resto da fase consome.

**Technical actions:**

1. Instalar em `nestjs-project` (dentro do container): `bullmq@^6.7.10`, `ioredis@^6.1.0` (peer **opcional** do bullmq 6: o npm não instala sozinho e, sem ele, o BullMQ falha ao conectar), `@nestjs/bullmq@^11.0.5` (a v12 é ESM-only e não carrega no Jest CommonJS do projeto; ver `library-refs.md`), `@aws-sdk/client-s3@^3.1177.0`, `@aws-sdk/s3-request-presigner@^3.1177.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-05`, `phase-03-videos/TD-07`; versões em `library-refs.md`).
2. Criar `src/config/queue.config.ts` (`registerAs('queue')`: `host`, `port`, `prefix`), `src/config/storage.config.ts` (`registerAs('storage')`: `endpoint`, `publicEndpoint`, `region`, `accessKey`, `secretKey`, `videosBucket`, `thumbnailsBucket`) e `src/config/video.config.ts` (`registerAs('video')`: as 7 chaves `VIDEO_*`), conforme `### Configuration & Infrastructure` (inherited `phase-01-configuracao-base/TD-03`; per `phase-03-videos/TD-06`).
3. Estender `src/config/env.validation.ts` com as 17 chaves novas, com regras e defaults exatamente como na tabela de `### Configuration & Infrastructure` (inherited `phase-01-configuracao-base/TD-02`), e acrescentar as 4 chaves `S3_*` obrigatórias ao `requiredEnv` de `src/config/env.validation.integration-spec.ts`, senão os testes existentes desse arquivo falham.
4. Extrair o array `load` do `ConfigModule.forRoot` de `src/app.module.ts` para uma constante exportada em `src/config/config-load.ts`, acrescentando `queueConfig`, `storageConfig` e `videoConfig`, para que o `WorkerModule` (SI-03.16) carregue a mesma lista sem duplicação.
5. Atualizar `nestjs-project/.env.example` com as 17 chaves e os valores da coluna `.env.example` (`S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://minio.localhost:9000`, …) e sincronizar o `.env` local (não versionado) com as chaves novas, senão o bootstrap falha nas chaves `required` (per `phase-03-videos/TD-16`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (chaves de fila, storage e vídeo) | Integration: obrigatórias (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`), defaults, limites de `VIDEO_UPLOAD_PART_SIZE_BYTES`, TTLs e `S3_SECRET_KEY` min 8 | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Subir a API sem `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY` ou `S3_SECRET_KEY` falha na validação Joi e o app não inicia.
- `VIDEO_UPLOAD_PART_SIZE_BYTES=1048576` (abaixo de 5 MiB) é rejeitado na validação; quando omitido, o valor efetivo é `67108864`.
- `S3_SECRET_KEY` com menos de 8 caracteres é rejeitado na validação.
- Com o `.env` sincronizado a partir do `.env.example`, `GET /` continua retornando `200` e a suíte existente segue verde.

---

### SI-03.2 — Infra: FFmpeg na imagem dev e serviços redis, minio e minio-init no Compose

**Description:** Provisiona a infraestrutura local da fase (fila, storage S3-compatível com buckets e CORS, e o binário FFmpeg), mantendo os comandos de DoD inalterados em `nestjs-api`.

**Technical actions:**

1. `Dockerfile.dev`: acrescentar `ffmpeg` ao `apt install -y` (traz `ffprobe`). A imagem é compartilhada por `nestjs-api` e `video-worker` e exige um `docker compose build` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`).
2. `compose.yaml`: serviço `redis` — `redis:8-alpine`, `redis-server --maxmemory-policy noeviction`, porta `6379`, healthcheck `redis-cli ping` (per `phase-03-videos/TD-01`).
3. `compose.yaml`: serviço `minio` — `cgr.dev/chainguard/minio@sha256:<digest>` (digest fixado na implementação), `server /data --address :9000 --console-address :9001`, `MINIO_ROOT_USER: ${S3_ACCESS_KEY:-streamtube}`/`MINIO_ROOT_PASSWORD: ${S3_SECRET_KEY:-streamtube-secret}` (default igual ao `.env.example`, porque o `.env` não é versionado; o `minio-init` usa a mesma interpolação), portas `9000:9000` + `9001:9001`, volume nomeado, alias de rede **`minio.localhost`** e healthcheck de readiness validado contra a imagem fixada (per `phase-03-videos/TD-08`, `phase-03-videos/TD-16`).
4. `compose.yaml`: serviço one-shot `minio-init` com a imagem **`cgr.dev/chainguard/minio`** (mesmo digest; a `minio-client` não tem `sh`), `entrypoint: ["sh", "-c"]`, `depends_on: minio: service_healthy`; script idempotente com `mc alias set`, `mc mb -p` de `videos`, `thumbnails`, `videos-test` e `thumbnails-test` e `mc anonymous set download` nos dois de thumbnails; **sem CORS por bucket** (o CORS padrão do MinIO já expõe `ETag`). E `nestjs-api.depends_on` ganha `redis` e `minio` (`service_healthy`) e `minio-init` (`service_completed_successfully`) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08` Note, `phase-03-videos/TD-14`).
5. `CLAUDE.md` da raiz, seção "Docker Networking": registrar a exceção `S3_PUBLIC_ENDPOINT=http://minio.localhost:9000` com o texto de `### Configuration & Infrastructure` → "Docker Networking exception", incluindo o aviso de que curl não serve para testar `*.localhost` de dentro de container (per `phase-03-videos/TD-16` e Note).

**Tests:** _(empty — Infra; verificado pelos ACs de container e pela suíte existente seguindo verde)_

**Dependencies:** SI-03.1 — o Compose interpola as credenciais do MinIO a partir das chaves `S3_*` novas.

**Acceptance criteria:**

- `docker compose build && docker compose up -d` deixa `redis` e `minio` healthy e `minio-init` sai com código 0; um segundo `docker compose up -d` também termina com `minio-init` em código 0 (init idempotente).
- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` saem com código 0.
- `docker compose exec redis redis-cli ping` responde `PONG`.
- Sem `.env` (clone novo), `docker compose up -d` ainda deixa `minio` healthy e `minio-init` em código 0.
- Dentro de `nestjs-api`, `node -e "fetch('http://minio.localhost:9000/minio/health/ready').then(r => process.exit(r.status === 200 ? 0 : 1))"` sai com código 0 (o alias resolve para o serviço de storage, não para o loopback do container; curl não serve aqui, ver `phase-03-videos/TD-16` Note); do host, `curl http://minio.localhost:9000/minio/health/ready` retorna `200`.
- Um GET com `Origin` num objeto de `thumbnails` responde com `Access-Control-Expose-Headers` contendo `ETag` (CORS padrão do MinIO).
- O `CLAUDE.md` da raiz documenta a exceção `minio.localhost` em "Docker Networking".
- GET anônimo de um objeto em `thumbnails` retorna `200`; GET anônimo de um objeto em `videos` retorna `403`.
- `npm test` e `npm run test:e2e` seguem verdes com a nova topologia.

---

### SI-03.3 — Infra: isolamento do ambiente de teste e `--runInBand` no `test:e2e`

**Description:** Garante que o processo do Jest nunca compartilhe fila nem buckets com os containers (decisão do gate G3a) e corrige o `test:e2e`, que hoje roda em paralelo apesar do que o `CLAUDE.md` afirma.

**Technical actions:**

1. Criar `src/test/setup-test-env.ts`, que força em `process.env`: `QUEUE_PREFIX=test`, `S3_VIDEOS_BUCKET=videos-test`, `S3_THUMBNAILS_BUCKET=thumbnails-test`, `VIDEO_MAX_UPLOAD_BYTES=12582912`, `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` (per `### Configuration & Infrastructure` → Test environment isolation; `phase-03-videos/TD-14`, `phase-03-videos/TD-06`).
2. `package.json` → `jest.setupFiles`: `["dotenv/config", "<rootDir>/test/setup-test-env.ts"]` (o `rootDir` desse config é `src`), com o setup **depois** de `dotenv/config`.
3. `test/jest-e2e.json` → `setupFiles`: `["dotenv/config", "<rootDir>/../src/test/setup-test-env.ts"]`. O `rootDir: "."` desse config é resolvido a partir da pasta do próprio arquivo, ou seja `test/` (confirmado com `npx jest --config ./test/jest-e2e.json --showConfig` → `/home/node/app/test`).
4. `package.json` → scripts `test`: `jest --runInBand` e `test:e2e`: `jest --config ./test/jest-e2e.json --runInBand` (as integrações novas compartilham fila `test` e buckets `-test`, e o critério do desafio cita literalmente `npm test`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `setup-test-env.ts` | Unit: sob o Jest, `QUEUE_PREFIX`, buckets e limites de upload têm os valores de teste mesmo com o `.env` definindo os de produção | `src/test/setup-test-env.spec.ts` |

**Dependencies:** SI-03.2 — os buckets `videos-test`/`thumbnails-test` são criados pelo `minio-init`.

**Acceptance criteria:**

- Dentro do Jest (unit/integration e e2e), `QUEUE_PREFIX` vale `test` e os buckets valem `videos-test`/`thumbnails-test`, mesmo com o `.env` definindo `bull`/`videos`/`thumbnails`.
- `npm test` e `npm run test:e2e` executam os arquivos em série, sem `-- --runInBand` manual, e as suítes seguem verdes.
- Os containers (`nestjs-api` em dev e, depois, `video-worker`) continuam lendo `QUEUE_PREFIX=bull` e os buckets de produção; o override existe só no processo do Jest.

---

### SI-03.4 — Entidade `Video`, migration `CreateVideos` e ajustes nos testes existentes

**Description:** Cria a tabela `videos` com os dois eixos de status e aplica, no mesmo passo, o fallout da migration nos testes existentes, para a suíte continuar verde.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com colunas, enums (`videos_processing_status_enum`, `videos_publication_status_enum`), defaults, transformer `bigint ↔ number` em `size_bytes`/`upload_part_size_bytes`, `@ManyToOne(() => Channel)` via `channel_id` e os três índices, exatamente como em `### Data Model` → `#### Video` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-12`, `phase-03-videos/TD-15`).
2. Gerar a migration no container (`npm run migration:generate -- src/database/migrations/CreateVideos`), revisar os dois enum types, a FK para `channels` e os três índices, e rodar `npm run migration:run`.
3. `src/database/migrations.integration-spec.ts`: `MANAGED_TABLES` + `videos`; `MANAGED_ENUM_TYPES` + `videos_processing_status_enum` e `videos_publication_status_enum`; a classe `CreateVideos…` no array `migrations` e `Video` nas entidades; `toHaveLength(2)` → `toHaveLength(3)`; o `toEqual` da lista de tabelas passa a 5; e o teste de revert, que agora desfaz a `CreateVideos` (última migration), passa a afirmar que `videos` e os 2 enum types somem (o `afterAll` continua reaplicando tudo).
4. `src/test/create-test-data-source.ts` → `cleanAllTables`: `DELETE FROM "videos"` antes de `DELETE FROM "channels"`.
5. Acrescentar `Video` a todo `ALL_ENTITIES` dos specs existentes (localizar com `grep -rn ALL_ENTITIES src test`: `auth.module.spec.ts`, `auth.service.integration-spec.ts`, specs de `refresh-token`/`verification-token`, `users.module.spec.ts`, `users.service.integration-spec.ts`, `channels.service.integration-spec.ts` e demais).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults (`uploading`, `draft`), `title` not null, `public_id` único (`23505`), FK `channel_id`, round-trip `bigint` como `number`, metadados nuláveis | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: 3 migrations aplicadas; `videos` e os 2 enum types gerenciados; revert limpo | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Inserir um `Video` só com os campos obrigatórios (incluindo `title`) grava `processing_status = 'uploading'` e `publication_status = 'draft'`; sem `title`, o insert viola o `NOT NULL`.
- Inserir dois vídeos com o mesmo `public_id` viola a constraint única (`23505`).
- Inserir um vídeo com `channel_id` inexistente viola a FK.
- `size_bytes = 10737418240` é lido de volta como o `number` `10737418240`.
- `migration:run` seguido de `migration:revert` remove `videos` e os dois enum types sem resíduo.
- A suíte completa segue verde com `cleanAllTables` e `ALL_ENTITIES` atualizados.

---

### SI-03.5 — Módulo de storage (adapter S3 com client interno e público)

**Description:** Encapsula todas as operações S3 da fase (multipart, objetos, presign) atrás de um `StorageService`, com o client interno para chamadas SDK e o público para URLs entregues ao cliente.

**Technical actions:**

1. Criar `src/storage/storage.constants.ts` (tokens `S3_INTERNAL_CLIENT`, `S3_PUBLIC_CLIENT`) e `src/storage/storage.module.ts` com dois providers `S3Client` montados de `storageConfig` (`endpoint` = `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT`, `forcePathStyle: true`, região, credenciais, `requestChecksumCalculation: 'WHEN_REQUIRED'`: o SDK 3.1177 põe `x-amz-checksum-*` nas URLs pré-assinadas de parte, o MinIO aceita, mas o S3 da AWS pode rejeitar, cf. aws-sdk-js-v3 #6810), exportando `StorageService` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`, `phase-03-videos/TD-16`).
2. `src/storage/storage.service.ts` — multipart: `createMultipartUpload(key)`, `listAllParts(key, uploadId)` paginando até esgotar, `completeMultipartUpload(key, uploadId, parts)` com parts ordenadas por `PartNumber`, `abortMultipartUpload(key, uploadId)` tolerando `NoSuchUpload` (per `phase-03-videos/TD-05`).
3. `StorageService` — objetos: `headObject(bucket, key)` (retorna `null` em `NotFound`), `deleteObject(bucket, key)`, `putObject(bucket, key, body, contentType)` e `publicObjectUrl(bucket, key)` = `{S3_PUBLIC_ENDPOINT}/{bucket}/{key}` (path-style, sem assinatura) (per `phase-03-videos/TD-07`).
4. `StorageService` — presign via `getSignedUrl`: `presignUploadPart(key, uploadId, partNumber, ttlSeconds)` sempre com o client público, e `presignGetObject(key, ttlSeconds, { client: 'public' | 'internal', disposition? })` — URLs para o cliente com o client público, a leitura do worker com o interno (per `phase-03-videos/TD-04`, `phase-03-videos/TD-10`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilação com `storageConfig` real | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration (MinIO real, buckets `-test`): PUT nas URLs de parte → `listAllParts` → complete → `headObject`; abort repetido tolerado; GET pré-assinado com `Range` → `206`; `ResponseContentDisposition` refletido; URL pública de thumbnail sem assinatura; host `minio.localhost` nas URLs públicas | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — a integração roda contra os buckets `-test` e o MinIO do Compose.

**Acceptance criteria:**

- Um upload multipart feito por PUTs nas URLs pré-assinadas de parte, seguido de complete, produz um objeto cujo `ContentLength` é a soma das partes.
- Abortar um `uploadId` que já foi abortado não lança erro.
- GET na URL pré-assinada de leitura com `Range: bytes=0-99` retorna `206` com 100 bytes.
- Toda URL pré-assinada entregue ao cliente começa com `http://minio.localhost:9000`, e a mesma URL é válida de dentro de `nestjs-api` e do host.
- GET anônimo em `publicObjectUrl(thumbnailsBucket, key)` retorna `200`.
- `headObject` de uma chave inexistente retorna `null`.

---

### SI-03.6 — Módulo de fila (BullMQ) compartilhado entre API e worker

**Description:** Cria a conexão BullMQ e as duas filas da fase num `QueueModule` reutilizável, com a API atuando só como produtora, mais o helper de limpeza de filas usado pelos testes.

**Technical actions:**

1. Criar `src/queue/queue.constants.ts`: `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_MAINTENANCE_QUEUE = 'video-maintenance'`, `PROCESS_VIDEO_JOB = 'process-video'` e `processVideoJobOptions(videoId)` (`jobId: videoId`, `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: { count: 1000 }`) (per `### Events/Messages` → `#### process-video`; `phase-03-videos/TD-01`, `phase-03-videos/TD-12`).
2. Criar `src/queue/queue.module.ts`: `BullModule.forRootAsync` (`inject: [queueConfig.KEY]`, `connection: { host, port }`, `prefix`) + `BullModule.registerQueue` das duas filas, exportando `BullModule`.
3. Importar `QueueModule` em `AppModule` como produtor: nenhum `@Processor` é registrado na API (per `phase-03-videos/TD-02`).
4. Criar `src/test/queues.ts` com `obliterateTestQueues(moduleRef)`: `obliterate({ force: true })` nas filas de prefixo `test` e fechamento de queues/workers, para uso em `afterAll` (per `### Configuration & Infrastructure` → Test environment isolation; `phase-03-videos/TD-14`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Integration (Redis real): compilação com `queueConfig` real; as duas filas resolvem com prefixo `test`; `processVideoJobOptions` deduplica por `jobId` | `src/queue/queue.module.integration-spec.ts` |

**Dependencies:** SI-03.3 — o prefixo `test` precisa estar ativo no Jest antes de qualquer fila ser criada nos testes.

**Acceptance criteria:**

- Dentro do Jest, um job adicionado em `video-processing` fica sob as chaves `test:video-processing:*`, nunca sob `bull:*`.
- Adicionar `process-video` duas vezes com o mesmo `jobId` resulta em um único job na fila.
- Com apenas a API iniciada (sem `WorkerModule`), `video-processing` tem `0` workers conectados.
- As suítes e2e existentes terminam sem open handles (conexões Redis fechadas no `app.close()`).

---

### SI-03.7 — Fundações do domínio de vídeos (exceções, `publicId`, resposta e lookup de canal)

**Description:** Prepara as peças compartilhadas por todos os endpoints de vídeo e registra o `VideosModule`, mantendo o lookup de canal dentro do domínio de canais.

**Technical actions:**

1. Criar `src/videos/videos.exceptions.ts` com as 9 subclasses de `DomainException` do `### Error Catalog`, com código, status HTTP e mensagem literais (inherited `phase-02-auth/TD-07`).
2. Criar `src/videos/public-id.util.ts`: `generatePublicId()` (`randomBytes(8).toString('base64url')`, 11 caracteres) e `PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/` (per `phase-03-videos/TD-09`).
3. `ChannelsService` ganha `findIdByUserId(userId)` e `lockIdByUserId(manager, userId)` (`pessimistic_write` dentro da transação do chamador), ambos retornando `string | null`, para que o domínio de vídeos não consulte `channels` diretamente (per `phase-03-videos/TD-15`).
4. Criar `src/videos/dto/video-response.dto.ts` (`VideoResponseDto` com `@ApiProperty` dos 19 campos de `VideoResponse`, incluindo `title`) e `src/videos/video-response.mapper.ts` com `toVideoResponse(video, thumbnailUrl)` (snake_case → camelCase, datas em ISO-8601) (inherited `openapi-docs-nestjs/TD-01`).
5. Criar `src/videos/videos.module.ts` (`TypeOrmModule.forFeature([Video])`, imports `ChannelsModule`, `StorageModule`, `QueueModule`) e registrá-lo em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generatePublicId` | Unit: 11 caracteres, casa `PUBLIC_ID_PATTERN`, valores distintos | `src/videos/public-id.util.spec.ts` |
| `toVideoResponse` | Unit: nomes camelCase, `thumbnailUrl` repassada ou `null`, datas ISO-8601, `processedAt` nulo | `src/videos/video-response.mapper.spec.ts` |
| `ChannelsService` (lookup por usuário) | Integration: id do canal ou `null`; lock dentro de transação | `src/channels/channels.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.4 (entidade `Video`), SI-03.5 (`StorageModule`), SI-03.6 (`QueueModule`)

**Acceptance criteria:**

- `generatePublicId()` produz strings base64url de 11 caracteres, e 10.000 chamadas seguidas não repetem valor.
- Cada exceção de vídeo lançada num handler é renderizada como `{ statusCode, error, message }` com o código e o status do `### Error Catalog` (ex.: `VideoNotFoundException` → `404` `VIDEO_NOT_FOUND`).
- `findIdByUserId` de um usuário sem canal retorna `null`.
- A API sobe com `VideosModule` registrado e `GET /` segue retornando `200`.

---

### SI-03.8 — Endpoint POST /videos/uploads

**Route:** POST /videos/uploads
**Test Specs:** see `nestjs-project/specs/videos-uploads.plan.md`
**Authorization:** JWT obrigatório; o upload vai sempre para o canal do próprio caller (per `### Authorization Matrix`)
**API Contract:** see `## Technical Specifications` → `### API Contracts` → `#### POST /videos/uploads`

**Description:** Inicia o upload: pré-cadastra o vídeo como rascunho, abre o multipart no storage e devolve o primeiro lote de URLs de parte, sem nenhum byte de vídeo passando pela API.

**Technical actions:**

1. Criar `src/videos/dto/initiate-upload.dto.ts` (`fileName` trim 1–255, `title` opcional trim 1–255, `sizeBytes` `@IsInt` `@Min(1)`, `mimeType` máx. 127 + `^video\/[\w.+-]+$`), `src/videos/dto/part-url.dto.ts` e `src/videos/dto/initiate-upload-response.dto.ts` (per `#### Validation Rules — video endpoints`; inherited `phase-02-auth/TD-06`).
2. `VideosService.initiateUpload(userId, dto)`, passos 1–2: canal via `ChannelsService.findIdByUserId` (`null` → `ChannelNotFoundException`); `sizeBytes > VIDEO_MAX_UPLOAD_BYTES` → `VideoTooLargeException`; `partSize = max(VIDEO_UPLOAD_PART_SIZE_BYTES, ceil(sizeBytes / 10000))` e `partCount = ceil(sizeBytes / partSize)`; `title` = o informado ou, quando omitido, `fileName` sem a extensão (o `fileName` inteiro se ficar vazio) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-05` Note).
3. Passos 3–4 numa transação: `ChannelsService.lockIdByUserId(manager, userId)`; contagem de vídeos `uploading` do canal ≥ `VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL` → `ActiveUploadLimitReachedException`; `id = randomUUID()`, `createMultipartUpload('{id}/source', dto.mimeType)` (estende a assinatura do `StorageService` do SI-03.5 para enviar `ContentType`: o S3 aplica o tipo ao objeto final, e o playback responde `video/*` em vez de `binary/octet-stream`, que navegadores estritos como o Safari recusam), insert com `generatePublicId()` e retry em `23505` na coluna `public_id` (máx. 5, cada tentativa num SAVEPOINT conforme `.claude/rules/typeorm-queries.md`; não copiar o padrão do `ChannelsService`, que não usa SAVEPOINT); se o insert falhar, `abortMultipartUpload` best-effort e rethrow (per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`, `phase-03-videos/TD-13`).
4. Passo 5: `presignUploadPart` para as partes `1..min(partCount, 100)` com TTL `VIDEO_UPLOAD_PART_URL_TTL_SECONDS` e resposta com `videoId`, `publicId`, `uploadId`, `partSize`, `partCount`, `parts`, `expiresAt`.
5. Criar `src/videos/videos.controller.ts` (`@ApiTags('videos')`, `@SkipThrottle()`, `@Controller('videos')`) com `@Post('uploads')` `@HttpCode(201)`, `@ApiBearerAuth('access-token')`, `@ApiOperation` e um `@ApiResponse` por status (201 tipado; 400/401/404/409/413 via `getSchemaPath(ApiErrorEnvelope)`) (per `phase-03-videos/TD-13`; inherited `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: fórmula de `partSize`/`partCount` (incluindo 10 GiB → 64 MiB / 160 partes); `title` padrão a partir do `fileName` (`aula.mp4` → `aula`, `.mp4` → `.mp4`); `VIDEO_TOO_LARGE` sem nenhuma chamada ao storage; abort best-effort quando o insert falha; retry de `public_id` em `23505` | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (Postgres + MinIO): linha `uploading`/`draft` com `upload_id`; multipart aberto (`listAllParts` vazio); limite → `ACTIVE_UPLOAD_LIMIT_REACHED`; duas iniciações concorrentes no limite deixam só uma passar; colisão forçada de `public_id` (spy em `generatePublicId` devolvendo um valor existente) é refeita via SAVEPOINT e o insert conclui na mesma transação | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `POST /videos/uploads` com `{ fileName, sizeBytes, mimeType: "video/mp4" }` válidos retorna `201` com `videoId`, `publicId` de 11 caracteres, `uploadId`, `partSize`, `partCount`, `parts` (≤100, `partNumber` crescente) e `expiresAt`; o vídeo fica `uploading`/`draft`.
- Para `sizeBytes = 10737418240` com os defaults, o cálculo dá `partSize = 67108864` e `partCount = 160` (verificado no teste unitário: no Jest o teto de upload é 12 MiB, então via HTTP a mesma chamada retorna `413`).
- `sizeBytes` acima de `VIDEO_MAX_UPLOAD_BYTES` retorna `413` `VIDEO_TOO_LARGE`, sem criar linha nem multipart.
- Com o canal já em `VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL` uploads `uploading`, retorna `409` `ACTIVE_UPLOAD_LIMIT_REACHED`.
- `mimeType: "image/png"` ou uma chave desconhecida no body retorna `400` `VALIDATION_ERROR`.
- Sem token retorna `401`.
- Dezenas de chamadas seguidas do mesmo IP nunca recebem `429` (rota fora do throttler).
- Sem `title` no body, o vídeo é criado com o `fileName` sem extensão como título (`aula-01.mp4` → `aula-01`); com `title`, o informado (após trim) é gravado.

---

### SI-03.9 — Endpoint POST /videos/:id/upload/part-urls

**Route:** POST /videos/:id/upload/part-urls
**Test Specs:** see `nestjs-project/specs/videos-upload-part-urls.plan.md`
**Authorization:** Owner apenas; não-dono recebe `404 VIDEO_NOT_FOUND` (per `### Authorization Matrix`)
**API Contract:** see `## Technical Specifications` → `### API Contracts` → `#### POST /videos/:id/upload/part-urls`

**Description:** Caminho de retomada do upload: consulta no storage as partes já gravadas e assina as faltantes. Introduz a checagem de dono reutilizada pelas demais rotas de dono.

**Technical actions:**

1. Criar `src/videos/dto/part-urls.dto.ts` (`partNumbers` opcional, `@ArrayMinSize(1)`, `@ArrayMaxSize(100)`, `@ArrayUnique()`, cada item `@IsInt` `@Min(1)`), `src/videos/dto/uploaded-part.dto.ts` e `src/videos/dto/part-urls-response.dto.ts` (per `#### Validation Rules — video endpoints`).
2. `VideosService.findOwnedOrFail(id, userId)`: carrega por `id` e compara `channel_id` com `ChannelsService.findIdByUserId(userId)`; vídeo ausente ou de outro canal → `VideoNotFoundException` (hide, don't forbid). Mais `assertUploading(video)` → `InvalidVideoStateException`. Ambos reutilizados por SI-03.10, SI-03.11 e SI-03.12 (per `phase-03-videos/TD-15`).
3. `VideosService.signPartUrls(id, userId, dto)`: `listAllParts`; algum `partNumber > partCount` → `InvalidPartNumberException`; sem `partNumbers`, assina as primeiras ≤100 partes faltantes em ordem crescente; com `partNumbers`, assina exatamente as pedidas; atualiza `updated_at` (atividade lida pela varredura) (per `phase-03-videos/TD-05`, `phase-03-videos/TD-12`).
4. `VideosController`: `@Post(':id/upload/part-urls')` `@HttpCode(200)` com `ParseUUIDPipe`, `@ApiBearerAuth('access-token')`, `@ApiOperation` e `@ApiResponse` para 200/400/401/404/409.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.signPartUrls` | Unit: seleção das faltantes (≤100, crescente); `INVALID_PART_NUMBER`; `parts` vazio quando nada falta | `src/videos/videos.service.spec.ts` |
| `VideosService.signPartUrls` / `findOwnedOrFail` | Integration (Postgres + MinIO): após PUT real da parte 1, `uploadedParts` traz a parte 1 com `size`/`etag` e `parts` começa na 2; `updated_at` avança; não-dono → `VIDEO_NOT_FOUND` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- Depois de a parte 1 ter sido enviada, `POST /videos/:id/upload/part-urls` sem body retorna `200` com `uploadedParts` contendo a parte 1 e `parts` assinando as faltantes a partir da 2.
- Com `partNumbers: [1]` para uma parte já enviada, retorna uma URL para a parte 1 (re-PUT permitido).
- Um `partNumber` maior que `partCount` retorna `400` `INVALID_PART_NUMBER`.
- Chamada de outro usuário e chamada com `id` inexistente retornam `404` `VIDEO_NOT_FOUND` com corpos idênticos.
- Vídeo fora de `uploading` retorna `409` `INVALID_VIDEO_STATE`.
- `id` que não é uuid retorna `400` `VALIDATION_ERROR`.
- A chamada avança o `updated_at` do vídeo.

---

### SI-03.10 — Endpoint POST /videos/:id/upload/complete

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner apenas; não-dono recebe `404 VIDEO_NOT_FOUND` (per `### Authorization Matrix`)
**API Contract:** see `## Technical Specifications` → `### API Contracts` → `#### POST /videos/:id/upload/complete`

**Description:** Fecha o multipart, confere o tamanho e enfileira o processamento, com o enqueue pós-commit cuja falha é logada e engolida (exceção deliberada documentada na spec).

**Technical actions:**

1. `VideosService.completeUpload(id, userId)`, passos 1–3: `findOwnedOrFail` + `assertUploading`; `listAllParts`; parte faltando em `1..partCount` → `UploadIncompleteException` (mensagem com as 20 primeiras e `…`), vídeo segue `uploading`; tamanho de parte fora do esperado (cada parte `n < partCount` com exatamente `partSize` e a última com `size_bytes − (partCount − 1) × partSize`, o que também garante a soma; sem isso o S3 recusa partes < 5 MiB com `EntityTooSmall` e a resposta viraria 500) → `UploadSizeMismatchException`, vídeo segue `uploading` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`).
2. Passo 4: `completeMultipartUpload` com as partes do `ListParts` ordenadas por `PartNumber`; em `NoSuchUpload`, lança `InvalidVideoStateException` (a linha já saiu de `uploading` ou um `complete` concorrente ainda não commitou; nunca 500).
3. Passos 5–6: `headObject` de backstop (`ContentLength ≠ size_bytes` ou > `VIDEO_MAX_UPLOAD_BYTES` → `deleteObject`, `failed` + `failure_reason = 'UPLOAD_SIZE_MISMATCH'` + `upload_id = null`, `UploadSizeMismatchException`); depois, update condicional (`WHERE id = :id AND processing_status = 'uploading'`) para `processing` + `upload_id = null`, e 0 linhas afetadas → `InvalidVideoStateException` (per `phase-03-videos/TD-12`).
4. Passo 7, após o commit: `@InjectQueue(VIDEO_PROCESSING_QUEUE)` + `add(PROCESS_VIDEO_JOB, { videoId }, processVideoJobOptions(videoId))` limitado por timeout de 3 s (`ENQUEUE_TIMEOUT_MS`; com o Redis fora do ar o `add` fica pendente indefinidamente). Se lançar ou estourar o timeout, `logger.error` com `videoId`, comentário no `catch` citando `### API Contracts` → `#### POST /videos/:id/upload/complete` passo 7, e o erro é engolido (exceção deliberada a `.claude/rules/nestjs-services.md`) (per `phase-03-videos/TD-01`).
5. `VideosController`: `@Post(':id/upload/complete')` `@HttpCode(202)` devolvendo `VideoResponseDto` via `toVideoResponse`, com `ParseUUIDPipe`, `@ApiBearerAuth('access-token')`, `@ApiOperation` e `@ApiResponse` para 202/400/401/404/409/422.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: enqueue que lança **ou que nunca resolve** (timeout, com fake timers) → retorna o vídeo `processing` e chama `logger.error` com `videoId`; `NoSuchUpload` → `INVALID_VIDEO_STATE`, com a linha já fora de `uploading` e também ainda `uploading`; update condicional com 0 linhas → `INVALID_VIDEO_STATE`; mensagem de `UPLOAD_INCOMPLETE` truncada em 20 | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (Postgres + MinIO + Redis): partes reais enviadas → objeto `{id}/source` completo com `ContentType` = `mime_type` (`headObject` passa a devolver também `contentType`), linha `processing` com `upload_id` nulo, job `process-video` com `jobId = videoId` na fila `test`; soma divergente → `UPLOAD_SIZE_MISMATCH` com a linha ainda `uploading`; partes de 4 MiB + 6 MiB num upload de 10 MiB (soma correta, parte 1 menor que `partSize`) → `UPLOAD_SIZE_MISMATCH`, nunca 500 | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.9 — reusa `findOwnedOrFail`/`assertUploading`.

**Acceptance criteria:**

- Com todas as partes enviadas, `POST /videos/:id/upload/complete` retorna `202` com `VideoResponse` em `processingStatus: "processing"`, e um job `process-video` com `jobId = videoId` entra na fila.
- Com partes faltando, retorna `409` `UPLOAD_INCOMPLETE` com os números faltantes em `message`, e o vídeo continua `uploading` (retomável via `part-urls`).
- Com a soma das partes diferente do `sizeBytes` declarado, ou com alguma parte de tamanho diferente do esperado, retorna `422` `UPLOAD_SIZE_MISMATCH`, e o vídeo continua `uploading`.
- Uma segunda chamada de `complete` retorna `409` `INVALID_VIDEO_STATE`.
- Com o Redis indisponível no momento do enqueue (o `add` falha ou fica pendente), a resposta ainda é `202` em até ~3 s e o log registra um erro de nível `error` com o `videoId`.
- Chamada de outro usuário retorna `404` `VIDEO_NOT_FOUND`.

---

### SI-03.11 — Endpoint DELETE /videos/:id/upload

**Route:** DELETE /videos/:id/upload
**Test Specs:** see `nestjs-project/specs/videos-upload-abort.plan.md`
**Authorization:** Owner apenas; não-dono recebe `404 VIDEO_NOT_FOUND` (per `### Authorization Matrix`)
**API Contract:** see `## Technical Specifications` → `### API Contracts` → `#### DELETE /videos/:id/upload`

**Description:** Permite ao dono abortar um upload em andamento, liberando o slot de upload ativo e o espaço das partes no storage.

**Technical actions:**

1. `VideosService.abortUpload(id, userId)`: `findOwnedOrFail` + `assertUploading` → `abortMultipartUpload` (`NoSuchUpload` tolerado) → `processing_status = 'failed'`, `failure_reason = 'UPLOAD_ABORTED'`, `upload_id = null` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-12`, `phase-03-videos/TD-13`).
2. `VideosController`: `@Delete(':id/upload')` `@HttpCode(204)` com `ParseUUIDPipe`, `@ApiBearerAuth('access-token')`, `@ApiOperation` e `@ApiResponse` para 204/400/401/404/409.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.abortUpload` | Integration (Postgres + MinIO): linha `failed`/`UPLOAD_ABORTED` com `upload_id` nulo; `listAllParts` do upload abortado falha com `NoSuchUpload`; nova iniciação no limite passa após o abort | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.9 — reusa `findOwnedOrFail`/`assertUploading`.

**Acceptance criteria:**

- `DELETE /videos/:id/upload` do dono retorna `204`, e o vídeo passa a `failed` com `failureReason: "UPLOAD_ABORTED"`.
- Um canal que estava no limite de uploads ativos consegue iniciar um novo upload logo após o abort.
- Repetir o `DELETE` no mesmo vídeo retorna `409` `INVALID_VIDEO_STATE`.
- Chamada de outro usuário retorna `404` `VIDEO_NOT_FOUND`.

---

### SI-03.12 — Endpoint GET /videos/:id

**Route:** GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-detail.plan.md`
**Authorization:** Owner apenas; não-dono recebe `404 VIDEO_NOT_FOUND` (per `### Authorization Matrix`)
**API Contract:** see `## Technical Specifications` → `### API Contracts` → `#### GET /videos/:id`

**Description:** Detalhe e status do vídeo para o dono, usado para acompanhar o processamento depois do `complete`.

**Technical actions:**

1. `VideosService.getOwned(id, userId)`: `findOwnedOrFail` + `toVideoResponse`, com `thumbnailUrl = storage.publicObjectUrl(thumbnailsBucket, thumbnail_key)` quando `thumbnail_key` existe e `null` caso contrário (per `phase-03-videos/TD-07`).
2. `VideosController`: `@Get(':id')` com `ParseUUIDPipe`, `@ApiBearerAuth('access-token')`, `@ApiOperation` e `@ApiResponse` para 200/400/401/404.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwned` | Unit: `thumbnailUrl` montada via `publicObjectUrl` quando há `thumbnail_key`, `null` quando não há | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.9 — reusa `findOwnedOrFail`.

**Acceptance criteria:**

- `GET /videos/:id` do dono retorna `200` com `VideoResponse` no status atual, com os metadados `null` antes do processamento.
- Com `thumbnail_key` preenchida, `thumbnailUrl` é `http://minio.localhost:9000/{S3_THUMBNAILS_BUCKET}/{id}/default.jpg` e abre sem assinatura.
- Chamada de outro usuário ou com `id` inexistente retorna `404` `VIDEO_NOT_FOUND`; sem token retorna `401`; `id` que não é uuid retorna `400` `VALIDATION_ERROR`.

---

### SI-03.13 — Guard de autenticação opcional (`@OptionalAuth`)

**Description:** Permite que rotas `@Public` identifiquem o dono quando há token, sem mudar o comportamento das rotas `@Public()` existentes. Pré-requisito das rotas de playback e download.

**Technical actions:**

1. Criar `src/auth/decorators/optional-auth.decorator.ts`: `IS_OPTIONAL_AUTH_KEY` e `OptionalAuth = () => applyDecorators(Public(), SetMetadata(IS_OPTIONAL_AUTH_KEY, true))` (per `phase-03-videos/TD-10` Note; `### Authorization Matrix` → Optional-auth mechanism).
2. `src/auth/guards/jwt-auth.guard.ts`: ler `IS_OPTIONAL_AUTH_KEY` (`getAllAndOverride` em handler + classe) **antes** do short-circuit de `isPublic`. Em rota opcional: sem header ou sem `Bearer ` → `true` com `request.user` indefinido; token que verifica → `request.user = payload`, `true`; token inválido/expirado → `UnauthorizedException`. `@Public()` puro continua retornando `true` sem ler o header.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `JwtAuthGuard` | Unit: as 4 ramificações — opcional sem header (anônimo), opcional com token válido (popula `request.user`), opcional com token inválido/expirado (`401`; o token expirado é criado com `jwtService.sign(payload, { expiresIn: -60 })`, nunca com `exp` no payload, que conflita com o `signOptions.expiresIn` do módulo), `@Public()` puro sem ler o header | `src/auth/guards/jwt-auth.guard.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- As rotas `@Public()` de `/auth/*` mantêm o comportamento atual, e `test/auth.e2e-spec.ts` segue verde.
- Numa rota `@OptionalAuth()`, uma requisição sem `Authorization` é atendida como anônima.
- Numa rota `@OptionalAuth()`, `Authorization: Bearer <token expirado>` retorna `401`, o que permite ao BFF disparar o refresh.
- Numa rota `@OptionalAuth()`, um token válido entrega o payload ao handler via `@CurrentUser()`.

---

### SI-03.14 — Endpoint GET /videos/:publicId/playback

**Route:** GET /videos/:publicId/playback
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** `@OptionalAuth()` — dono com vídeo `ready`; demais só quando publicado (em rascunho, `404`) (per `### Authorization Matrix`)
**API Contract:** see `## Technical Specifications` → `### API Contracts` → `#### GET /videos/:publicId/playback`

**Description:** Emite uma URL pré-assinada de curta duração para o `<video>` fazer Range/206 direto no storage, servindo o arquivo original, com a regra de visibilidade que mantém rascunhos privados.

**Technical actions:**

1. `VideosService.resolveViewable(publicId, caller?)`: `publicId` fora de `PUBLIC_ID_PATTERN` → `VideoNotFoundException` sem tocar o DB; carrega por `public_id`; visível = dono (canal do caller via `ChannelsService.findIdByUserId`) **ou** `publication_status ≠ 'draft'`; não visível → `VideoNotFoundException`; visível e não `ready` → `VideoNotReadyException` (per `phase-03-videos/TD-10` Note, `phase-03-videos/TD-12`).
2. `VideosService.getPlaybackUrl(publicId, caller?)`: `resolveViewable` + `presignGetObject(source_key, VIDEO_PLAYBACK_URL_TTL_SECONDS, { client: 'public' })` → `{ url, expiresAt }` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`, `phase-03-videos/TD-16`).
3. Criar `src/videos/dto/signed-url-response.dto.ts` (`url`, `expiresAt`) e, no `VideosController`, `@Get(':publicId/playback')` com `@OptionalAuth()`, `@CurrentUser() user: JwtPayload | undefined`, `@Header('Cache-Control', 'no-store')`, `@ApiBearerAuth('access-token')`, "authentication optional" no `@ApiOperation.description` e `@ApiResponse` para 200/401/404/409.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.resolveViewable` | Unit: `publicId` malformado não consulta o repositório; anônimo em rascunho → `VIDEO_NOT_FOUND`; não-dono em rascunho → `VIDEO_NOT_FOUND`; dono em `processing` → `VIDEO_NOT_READY`; dono em `ready` → visível | `src/videos/videos.service.spec.ts` |
| `VideosService.getPlaybackUrl` | Integration (Postgres + MinIO): a URL devolvida responde `206` a `Range: bytes=0-1023` e usa o host `minio.localhost` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.7 (domínio de vídeos), SI-03.13 (`@OptionalAuth`)

**Acceptance criteria:**

- O dono, com o vídeo `ready`, recebe `200` com `{ url, expiresAt }` e `Cache-Control: no-store`; GET na `url` com `Range: bytes=0-1023` retorna `206` direto do storage.
- Anônimo ou outro usuário num vídeo `draft` recebe `404` `VIDEO_NOT_FOUND`, com corpo idêntico ao de um `publicId` inexistente.
- `publicId` malformado (ex.: 5 caracteres) recebe `404` `VIDEO_NOT_FOUND`.
- O dono, com o vídeo ainda `processing`, recebe `409` `VIDEO_NOT_READY`.
- `Authorization` com token expirado recebe `401`.

---

### SI-03.15 — Endpoint GET /videos/:publicId/download

**Route:** GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** `@OptionalAuth()` — mesma regra da playback (per `### Authorization Matrix`)
**API Contract:** see `## Technical Specifications` → `### API Contracts` → `#### GET /videos/:publicId/download`

**Description:** Emite a URL pré-assinada de download, com `Content-Disposition: attachment` e o nome original do arquivo, reaproveitando a regra de visibilidade da playback.

**Technical actions:**

1. Criar `src/videos/content-disposition.util.ts` com `buildAttachmentDisposition(fileName)` → `attachment; filename="<ascii sanitizado>"; filename*=UTF-8''<RFC 5987>` (per `phase-03-videos/TD-10`).
2. `VideosService.getDownloadUrl(publicId, caller?)`: `resolveViewable` + `presignGetObject(source_key, VIDEO_PLAYBACK_URL_TTL_SECONDS, { client: 'public', disposition: buildAttachmentDisposition(original_filename) })` → `{ url, expiresAt }`.
3. `VideosController`: `@Get(':publicId/download')` com as mesmas anotações da playback (`@OptionalAuth()`, `Cache-Control: no-store`, OpenAPI 200/401/404/409).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildAttachmentDisposition` | Unit: nome só ASCII; acentos e emoji; aspas e barras invertidas; `filename*` codificado em UTF-8 | `src/videos/content-disposition.util.spec.ts` |
| `VideosService.getDownloadUrl` | Integration (Postgres + MinIO): GET na URL devolve `Content-Disposition: attachment` com o nome original | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.14 — reusa `resolveViewable` e o DTO de URL assinada.

**Acceptance criteria:**

- O dono, com o vídeo `ready`, recebe `200` com `{ url, expiresAt }` e `Cache-Control: no-store`; GET na `url` devolve o arquivo com `Content-Disposition: attachment`.
- Um `fileName` com acentos gera `filename` só com ASCII e `filename*=UTF-8''…` com o nome original codificado.
- Anônimo ou outro usuário num vídeo `draft` recebe `404` `VIDEO_NOT_FOUND`; o dono com o vídeo não `ready` recebe `409` `VIDEO_NOT_READY`; token expirado recebe `401`.

---

### SI-03.16 — Infra: `WorkerModule`, entrypoint `src/worker.ts` e serviço `video-worker`

**Description:** Cria o processo separado do worker (isolamento de processo, sem HTTP) a partir da mesma imagem e da mesma configuração da API, e o sobe no Compose.

**Technical actions:**

1. Extrair `src/database/typeorm-options.ts` com `buildTypeOrmOptions(dbConfig)` (`autoLoadEntities: true`, `synchronize: false`), usado pelo `TypeOrmModule.forRootAsync` de `AppModule` e do `WorkerModule`, sem duplicar parâmetros de conexão (inherited conventions, phase 01).
2. Criar `src/worker/worker.module.ts`: `ConfigModule.forRoot` com o `load` de `src/config/config-load.ts` + `envValidationSchema`, `TypeOrmModule.forRootAsync` com `buildTypeOrmOptions`, `TypeOrmModule.forFeature([Video, Channel, User])` (as relações `Video → Channel → User` exigem as três com `autoLoadEntities`), `QueueModule` e `StorageModule`; nenhum controller, `AuthModule` ou throttler (per `phase-03-videos/TD-02`).
3. Criar `src/worker.ts`: `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`, sem listener HTTP; script `start:worker` em `package.json` com `ts-node -r tsconfig-paths/register src/worker.ts` (mesmo padrão de `openapi:export`, sem disputar o `dist/` com o `start:dev` da API).
4. `compose.yaml`: serviço `video-worker` com o mesmo `build`/volume do `nestjs-api`, `command` executando `npm run start:worker`, `restart: unless-stopped` (num clone novo ele sobe antes de `node_modules`/`.env`/migrations e precisa se recuperar) e `depends_on` `db`/`redis`/`minio` (`service_healthy`) + `minio-init` (`service_completed_successfully`) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-14`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Integration (Postgres + Redis reais): compilação; nenhum controller registrado | `src/worker/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.4 (entidade `Video`), SI-03.5 (`StorageModule`), SI-03.6 (`QueueModule`)

**Acceptance criteria:**

- `docker compose up -d video-worker` sobe o worker, os logs mostram o contexto Nest inicializado e o container não abre nenhuma porta HTTP.
- `docker compose stop video-worker` encerra o processo de forma limpa (shutdown hooks), sem ser morto por timeout.
- Num ambiente recriado (`docker compose down -v && docker compose up -d`), depois de `npm install` + `migration:run`, o `video-worker` fica `running` sozinho (restart policy) ou após `docker compose restart video-worker`, sem ficar `Exited`.
- A API continua subindo com os mesmos parâmetros de conexão: `GET /` retorna `200` e as suítes existentes seguem verdes.

---

### SI-03.17 — Ferramentas de mídia: wrapper `ffprobe`/`ffmpeg` e fixtures

**Description:** Wrapper tipado sobre `execFile` (sem shell, sem `fluent-ffmpeg`) para extrair metadados e um frame, com a classificação de erro permanente × transitório que o consumer usa.

**Technical actions:**

1. Criar `src/videos/processing/media-metadata.util.ts` (funções puras): `mapProbeOutput(json)` → `MediaMetadata` (`durationSeconds`, `formatName`, `width`/`height`/`videoCodec` do primeiro stream de vídeo, `audioCodec` do primeiro stream de áudio ou `null`), lançando `InvalidMediaError` quando não há stream de vídeo; e `thumbnailTimestamp(duration)` = `min(duration × 0.1, 10)`, com `0` para duração desconhecida ou < 1 s (per `phase-03-videos/TD-03`).
2. Criar `src/videos/processing/media-tools.service.ts` com `probe(input)` via `execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], { timeout: 120000 })` e `extractFrame(input, atSeconds, outPath)` via `execFile('ffmpeg', ['-ss', t, '-i', input, '-frames:v', '1', out], { timeout: 120000 })` (mesmo timeout do `probe`, para um ffmpeg travado não prender o slot do worker) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`).
3. Classificação de erro no wrapper: saída ≠ 0 com marcador de parse no stderr (`Invalid data found when processing input`, `moov atom not found`) → `InvalidMediaError`; timeout e demais saídas ≠ 0 → `MediaToolTransientError` (per `### Events/Messages` → Error classification).
4. Gerar uma vez com ffmpeg e versionar as fixtures `test/fixtures/sample-2s.mp4` (testsrc + tom, poucos KB) e `test/fixtures/not-a-video.mp4` (bytes aleatórios).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `mapProbeOutput` / `thumbnailTimestamp` | Unit: política de frame (curto, longo, desconhecido); sem áudio → `audioCodec: null`; sem stream de vídeo → `InvalidMediaError` | `src/videos/processing/media-metadata.util.spec.ts` |
| `MediaToolsService` | Unit (`execFile` mockado): processo morto pelo timeout (`killed`/`SIGTERM`) em `probe` e em `extractFrame` → `MediaToolTransientError`; saída ≠ 0 com `moov atom not found` no stderr → `InvalidMediaError`; outra saída ≠ 0 → `MediaToolTransientError` | `src/videos/processing/media-tools.service.spec.ts` |
| `MediaToolsService` | Integration (ffprobe/ffmpeg reais + MinIO): `probe` do `sample-2s.mp4` via URL pré-assinada interna retorna duração ≈ 2 s, dimensões e codecs; `extractFrame` grava um JPEG; `not-a-video.mp4` → `InvalidMediaError` | `src/videos/processing/media-tools.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — a integração lê a fixture por URL pré-assinada interna (e usa o FFmpeg instalado em SI-03.2).

**Acceptance criteria:**

- `probe` do `sample-2s.mp4` servido por URL pré-assinada interna retorna `durationSeconds` ≈ 2, `width`/`height` da fixture e `videoCodec`/`audioCodec` preenchidos.
- `probe` do `not-a-video.mp4` falha com erro classificado como mídia inválida (permanente).
- `extractFrame` no segundo `thumbnailTimestamp(2)` (= 0,2 s) grava um arquivo JPEG válido.
- Um ffprobe ou ffmpeg que excede o timeout falha com erro classificado como transitório.

---

### SI-03.18 — Consumer `process-video` (metadados e thumbnail)

**Description:** Processa cada vídeo enviado no worker: lê só o necessário da fonte via HTTP Range, grava os metadados e o thumbnail e aplica retry/falha conforme a classificação de erro.

**Technical actions:**

1. Criar `src/videos/processing/video-processing.service.ts` com `process(videoId)`, passos 1–5 de `### Events/Messages` → `#### process-video`: no-op logado para vídeo ausente, `uploading` ou `failed`; `headObject` interno (`null` → erro permanente `PROCESSING_ERROR`); presign GET **interno** com TTL 3600 s como `-i`; `probe`; `extractFrame` num arquivo em `os.tmpdir()` removido no `finally`; `putObject` em `S3_THUMBNAILS_BUCKET` `{id}/default.jpg` com `image/jpeg` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-07`).
2. Passo 6 e falhas: update condicional (`WHERE id = :id AND processing_status IN ('processing','ready')`) com os metadados, `thumbnail_key`, `processing_status = 'ready'`, `processed_at = now()` e `failure_reason = null`; `markFailed(videoId, reason)` com a mesma condição (per `phase-03-videos/TD-12`).
3. Criar `src/videos/processing/video-processing.consumer.ts`: `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 2 })` estendendo `WorkerHost`. Erro permanente → `markFailed(INVALID_MEDIA | PROCESSING_ERROR)` + `UnrecoverableError`; transitório na última tentativa (`job.attemptsStarted >= (job.opts.attempts ?? 1)`) → `markFailed(PROCESSING_ERROR)` e rethrow; transitório antes disso → rethrow (per `phase-03-videos/TD-01`, `phase-03-videos/TD-12`).
4. Registrar `MediaToolsService`, `VideoProcessingService` e `VideoProcessingConsumer` no `WorkerModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingConsumer` | Unit: permanente → `markFailed` + `UnrecoverableError`; transitório não-final → só rethrow; transitório final → `markFailed(PROCESSING_ERROR)` + rethrow | `src/videos/processing/video-processing.consumer.spec.ts` |
| `VideoProcessingService` | Integration (Postgres + MinIO + ffprobe/ffmpeg): fixture válida → `ready` com metadados, `thumbnail_key` e objeto `image/jpeg` em `thumbnails-test`; fixture inválida → `INVALID_MEDIA`; fonte ausente → `PROCESSING_ERROR`; reexecução em `ready` sobrescreve sem erro; linha `failed` não é ressuscitada | `src/videos/processing/video-processing.service.integration-spec.ts` |

**Dependencies:** SI-03.16 (`WorkerModule`), SI-03.17 (ferramentas de mídia)

**Acceptance criteria:**

- Um job `process-video` para um vídeo `processing` com fonte válida deixa o vídeo `ready`, com `durationSeconds`, `width`, `height`, `videoCodec`, `formatName`, `processedAt` e um `thumbnailUrl` acessível anonimamente.
- Uma fonte que não é vídeo deixa o vídeo `failed` com `failureReason: "INVALID_MEDIA"` e o job vai a `failed` sem retentativas.
- Uma falha transitória persistente gera 3 tentativas com backoff exponencial e termina com o vídeo `failed` em `PROCESSING_ERROR`.
- Um job para vídeo `uploading` ou `failed` termina sem alterar a linha.
- Nenhum arquivo temporário de thumbnail fica em `os.tmpdir()` após o job, com sucesso ou falha.

---

### SI-03.19 — Varredura de manutenção (`video-maintenance`)

**Description:** Job agendado no worker que encerra uploads abandonados (controle de custo de storage) e recupera vídeos `processing` órfãos do enqueue não transacional.

**Technical actions:**

1. Criar `src/videos/processing/video-maintenance.service.ts` com `sweepStaleUploads()`: até 100 linhas `uploading` com `updated_at < now() - VIDEO_UPLOAD_STALE_AFTER_MS`, mais antigas primeiro; claim condicional (`WHERE id = :id AND processing_status = 'uploading'`) para `failed`/`UPLOAD_ABANDONED`/`upload_id = null` e, só quando afetou 1 linha, `abortMultipartUpload` com o `upload_id` anterior (per `phase-03-videos/TD-12`).
2. `sweepOrphanedProcessing()`: até 100 linhas `processing` com `updated_at < now() - VIDEO_SWEEP_INTERVAL_MS`; `getJob(videoId)` em `video-processing`: ausente → re-add com `processVideoJobOptions`; `failed` → update condicional para `failed`/`PROCESSING_ERROR`; waiting/active/delayed → nada. Erro numa linha é logado e não interrompe o lote (per `phase-03-videos/TD-01`).
3. Criar `src/videos/processing/video-maintenance.consumer.ts`: `@Processor(VIDEO_MAINTENANCE_QUEUE, { concurrency: 1 })` estendendo `WorkerHost`, chamando as duas varreduras.
4. Criar `src/videos/processing/video-maintenance.scheduler.ts`: no `onApplicationBootstrap`, `queue.upsertJobScheduler('video-maintenance-sweep', { every: VIDEO_SWEEP_INTERVAL_MS }, { name: 'sweep', data: {}, opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } } })` (bullmq v6, sem a API `repeat` legada; `library-refs.md` → bullmq).
5. Registrar `VideoMaintenanceService`, `VideoMaintenanceConsumer` e `VideoMaintenanceScheduler` no `WorkerModule` (a API nunca declara o scheduler).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoMaintenanceService` | Unit: decisão por estado do job (ausente → re-add; `failed` → `PROCESSING_ERROR`; waiting/active/delayed → nada); erro numa linha não interrompe as demais | `src/videos/processing/video-maintenance.service.spec.ts` |
| `VideoMaintenanceService` | Integration (Postgres + MinIO + Redis): upload envelhecido → `failed`/`UPLOAD_ABANDONED` e multipart abortado; linha `processing` órfã (enqueue perdido no `complete`) → job `process-video` re-enfileirado com `jobId = videoId`; job `failed` → `PROCESSING_ERROR`; claim perdido para um `complete` concorrente não aborta o multipart | `src/videos/processing/video-maintenance.service.integration-spec.ts` |
| `VideoMaintenanceScheduler` | Integration (Redis): dois bootstraps resultam em um único Job Scheduler `video-maintenance-sweep`, com o template salvo trazendo `removeOnComplete: { count: 50 }` e `removeOnFail: { count: 100 }` | `src/videos/processing/video-maintenance.scheduler.integration-spec.ts` |

**Dependencies:** SI-03.16 (`WorkerModule`)

**Acceptance criteria:**

- Um vídeo `uploading` sem atividade há mais de `VIDEO_UPLOAD_STALE_AFTER_MS` fica `failed` com `failureReason: "UPLOAD_ABANDONED"` após a varredura, e o multipart deixa de existir no storage.
- Um vídeo `processing` sem job na fila há mais de um intervalo de varredura recebe um novo job `process-video` com `jobId = videoId`.
- Um vídeo `processing` cujo job está `failed` no BullMQ fica `failed` com `failureReason: "PROCESSING_ERROR"`.
- Um vídeo `processing` com job waiting/active/delayed, ou atualizado há menos de um intervalo, não é alterado.
- Reiniciar o worker, ou subir uma segunda réplica, mantém um único scheduler `video-maintenance-sweep`.

---

### SI-03.20 — E2E do pipeline completo (upload → processamento → streaming/download)

**Description:** Prova os quatro entregáveis da fase de ponta a ponta num único processo Jest, com o app HTTP e o `WorkerModule` rodando juntos contra Postgres, MinIO, Redis e FFmpeg reais.

**Technical actions:**

1. Criar `test/helpers/video-pipeline.ts`: sobe o app HTTP (mesma configuração dos e2e existentes) **e** o `WorkerModule` no mesmo processo; helpers `uploadViaPresignedParts(initiateBody, filePath, { stopAfterPart? })` (PUT com `fetch` nas URLs de parte) e `waitForStatus(app, token, videoId, status, timeoutMs)` com polling em `GET /videos/:id` (per `phase-03-videos/TD-14`).
2. Em `beforeAll`, gerar com ffmpeg em `os.tmpdir()` um vídeo de tamanho determinístico entre 10 e 11,5 MiB (`testsrc` + ruído com bitrate fixo e `-fs 11M`: o ffmpeg grava o índice `moov` depois de atingir o limite, então o arquivo passa um pouco de 11 MiB, mas fica abaixo do teto de teste de 12 MiB), que vira 3 partes de 5 MiB; o helper falha cedo se o arquivo gerado tiver ≥ 12 MiB; o `sizeBytes` do initiate vem sempre do tamanho real do arquivo (`fs.statSync`); em `afterAll`, `obliterateTestQueues`, fechar worker e app, `cleanAllTables` e remover o arquivo, sem open handles.
3. Criar `test/videos-pipeline.e2e-spec.ts` com os fluxos: (a) upload de 3 partes com pausa após a parte 1 e retomada via `part-urls` → `complete` `202` → `ready` com metadados e thumbnail; (b) playback com `Range` → `206` e download com `Content-Disposition: attachment`; (c) `not-a-video.mp4` → `failed`/`INVALID_MEDIA`; (d) dois uploads geram `publicId`s distintos.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline de vídeo (API + worker) | E2E: upload multipart retomável → `ready` → playback `206` → download attachment; mídia inválida → `INVALID_MEDIA`; `publicId`s únicos | `test/videos-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.10 (`complete`), SI-03.12 (`GET /videos/:id`), SI-03.15 (playback/download), SI-03.18 (consumer `process-video`)

**Acceptance criteria:**

- Um vídeo de ~11 MiB enviado em 3 partes pré-assinadas, com pausa e retomada via `part-urls`, chega a `processingStatus: "ready"` dentro do timeout do teste, com `durationSeconds`, dimensões e `thumbnailUrl` preenchidos.
- A `url` de playback do vídeo pronto responde `206` a `Range: bytes=0-1023`, sem baixar o arquivo inteiro.
- A `url` de download responde com `Content-Disposition: attachment` e um corpo do tamanho declarado no upload.
- Dois uploads seguidos geram `publicId`s distintos de 11 caracteres.
- Um arquivo que não é vídeo termina `failed` com `failureReason: "INVALID_MEDIA"`.
- O ciclo usa apenas a fila de prefixo `test` e os buckets `-test`; nenhum job aparece sob `bull:*`.

---

### SI-03.21 — Documentação: `CLAUDE.md` (raiz e `nestjs-project`) e `openapi.json`

**Description:** Alinha a documentação operacional e o contrato OpenAPI versionado à nova topologia (fila, storage, worker) e registra a exceção de rede do `S3_PUBLIC_ENDPOINT`.

**Technical actions:**

1. `CLAUDE.md` da raiz (a exceção `minio.localhost` já entrou no SI-03.2): em "Repository Structure", corrigir `next-frontend/` — "not yet initialized" é falso, o diretório existe com as Fases 01/02 do front; em "Architecture", Message Queue deixa de ser "TBD" e passa a BullMQ sobre Redis (per `phase-03-videos/TD-01`), Object Storage passa a MinIO (per `phase-03-videos/TD-08`) e o Video Worker roda como container próprio a partir do mesmo código (per `phase-03-videos/TD-02`).
2. `nestjs-project/CLAUDE.md`: nova seção **"Vídeos"** (módulo e arquivos principais, tabela dos 7 endpoints com método, rota e auth, fluxo upload multipart → `complete` → fila → worker → status, buckets e chaves, mapeamento de status "rascunho → processando → pronto/erro" do `phase-03-videos/TD-12` Note); serviços `mailpit` (hoje ausente da lista), `redis`, `minio`, `minio-init` e `video-worker`, com a exceção explícita de que o `video-worker` sobe junto com o ambiente e a ordem `cp .env.example .env` → `up -d` → `npm install` → `migration:run` → `restart video-worker`; probes de startup (`docker compose exec redis redis-cli ping` e readiness do MinIO, nunca curl em `*.localhost` de dentro de container); `docker compose build` obrigatório após mudar o `Dockerfile.dev`; entrypoint e logs do worker (`npm run start:worker`, `docker compose logs -f video-worker`); `test:e2e` agora com `--runInBand` de fato; isolamento de teste via `src/test/setup-test-env.ts` (prefixo `test`, buckets `-test`) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-14`).
3. Regenerar `nestjs-project/openapi.json` com `docker compose exec nestjs-api npm run openapi:export` e versionar o diff (inherited `openapi-docs-nestjs/TD-02`).
4. Atualizar `docs/diagrams/software-arch.mermaid`: Message Queue sem "TBD" (BullMQ/Redis), Video Worker como container a partir do mesmo código e as relações de storage conforme `phase-03-videos/TD-05`/`TD-10` (browser ↔ storage por URLs pré-assinadas).
5. Estender `src/openapi-export.integration-spec.ts`: as 7 operações de vídeo presentes com tag `videos` e `summary` não vazio, segurança `access-token` nas rotas JWT e nas `@OptionalAuth()`, e respostas de erro referenciando `ApiErrorEnvelope` (inherited `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` exportado | Integration: 7 operações de vídeo com tag `videos`, `summary`, segurança `access-token` e erros via `ApiErrorEnvelope` | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.11 (última rota de dono), SI-03.19 (worker completo), SI-03.20 (pipeline provado)

**Acceptance criteria:**

- O `openapi.json` versionado lista as 7 operações de vídeo sob a tag `videos`, cada uma com `summary` e respostas de erro tipadas por `ApiErrorEnvelope`.
- No `openapi.json`, `GET /videos/{publicId}/playback` e `GET /videos/{publicId}/download` declaram a segurança `access-token` e "authentication optional" na descrição.
- O `CLAUDE.md` da raiz não mostra mais "Message Queue (TBD)" nem afirma que o `next-frontend/` não foi inicializado; o diagrama `software-arch.mermaid` também não tem mais "TBD".
- O `nestjs-project/CLAUDE.md` tem a seção "Vídeos" com os 7 endpoints e o mapeamento de status, e cada arquivo, comando e endpoint citado existe no código.
- Seguindo só o `nestjs-project/CLAUDE.md`, um dev reconstrói a imagem, sobe o ambiente, valida `redis`, `minio` e `video-worker` pelas probes listadas e roda os comandos do DoD sem passos extras.

---

## Technical Specifications

### Data Model

**Naming rule for this phase:** DB columns and entity properties follow the existing snake_case convention (`Channel.user_id`, `User.is_confirmed`). Wire names (JSON in API responses) are camelCase, exactly as the TDs spell them (`publicId`, `processingStatus`, `failureReason`, `videoId`, `uploadId`, `partSize`, `expiresAt`). Response DTOs do the mapping, and entities are never serialized directly.

#### Video

Entity file: `src/videos/entities/video.entity.ts`, table `videos`.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | Generated in the app (`crypto.randomUUID()`) **before** insert, because the storage key and the multipart upload need it before the row exists. Wire: `id` / `videoId` |
| public_id | varchar(11) | unique, not null | `randomBytes(8).toString('base64url')` (11 chars, 64 random bits), with a retry on unique violation (max 5 attempts, `QueryFailedError` code `23505` + column detail check), **each attempt inside a SAVEPOINT** per `.claude/rules/typeorm-queries.md`, because the insert runs inside the initiate transaction and a failed insert aborts it otherwise (`ChannelsService` retries without a SAVEPOINT; that latent bug is a separate task, not a pattern to copy) (per `phase-03-videos/TD-09`). Wire: `publicId` |
| title | varchar(255) | not null | Video title. Optional on initiate; defaults to `fileName` without its extension (the whole `fileName` when that is empty). Required by the challenge's "Persistência" minimum fields; editing is Phase 04 (per `phase-03-videos/TD-05` Note). Wire: `title` |
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

**Mapping to the challenge's status cycle** ("rascunho → processando → pronto/erro", per `phase-03-videos/TD-12` Note): rascunho = `publication_status = 'draft'` + `processing_status = 'uploading'`; processando = `processing`; pronto = `ready`; erro = `failed` (+ `failure_reason`). `publication_status` stays `draft` for the whole phase.

**Registration & migration:**
- `TypeOrmModule.forFeature([Video])` in `VideosModule` (API, where `Channel`/`User` are already registered by their own modules) and `TypeOrmModule.forFeature([Video, Channel, User])` in `WorkerModule` (worker): with `autoLoadEntities`, TypeORM only knows entities registered via `forFeature`, and `Video → Channel → User` relations need all three (otherwise `Entity metadata for Video#channel was not found`). Both roots use `autoLoadEntities: true`, built from the single `databaseConfig` factory (inherited convention: never duplicate connection params, so the TypeORM options builder is shared between `AppModule` and `WorkerModule`).
- Migration `CreateVideos` generated by the CLI inside the container (`npm run migration:generate -- src/database/migrations/CreateVideos`, because the `data-source.ts` entity glob already picks up `*.entity.ts`), then reviewed for both enum types, the FK and the three indexes.
- Test fallout that must land with the migration: `src/database/migrations.integration-spec.ts` (`MANAGED_TABLES` + `videos`, `MANAGED_ENUM_TYPES` + both new enum types, expected migration count 3), `cleanAllTables` (delete `videos` before `channels`), and every `ALL_ENTITIES` list in module specs.

**Out of this phase:** editing the title, description, visibility and custom thumbnails (Phase 04).

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
- title: string
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

#### POST /videos/uploads (SI-03.8)

Initiate upload: pre-registers the video as a draft and opens the multipart upload (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-13`, `phase-03-videos/TD-15`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- fileName: string, required — 1–255 characters
- title: string, optional — trimmed, 1–255 characters. When omitted, defaults to `fileName` without its extension (the whole `fileName` when that is empty)
- sizeBytes: integer, required — ≥ 1 (the upper bound is a domain check, not a DTO rule, so it returns `VIDEO_TOO_LARGE`)
- mimeType: string, required — max 127, matches `^video\/[\w.+-]+$`

**Behavior (order matters):**
1. Resolve the caller's channel by `channels.user_id = sub`.
2. Reject `sizeBytes > VIDEO_MAX_UPLOAD_BYTES`.
3. In one transaction holding a `pessimistic_write` lock on the caller's `channels` row: count the channel's videos with `processing_status = 'uploading'`. Reject when the count is ≥ `VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL`. Otherwise generate `id`, call `CreateMultipartUpload` on `{id}/source` with `ContentType = mimeType` (S3 applies it to the completed object, so playback serves `video/*`), then insert the `Video` (`uploading`, `draft`, `upload_id`, `upload_part_size_bytes`, `public_id` with retry).
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

#### POST /videos/:id/upload/part-urls (SI-03.9)

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

#### POST /videos/:id/upload/complete (SI-03.10)

Finishes the multipart upload, verifies the size and enqueues processing (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-01`, `phase-03-videos/TD-12`).

**Request headers:**
- Authorization: Bearer {access_token}

**Request path parameters:**
- id: uuid

**Request body:** none. The server builds the `{ PartNumber, ETag }` list from `ListParts`, so client-held ETags are neither needed nor trusted.

**Behavior (order matters):**
1. Owner + `processing_status = 'uploading'` check.
2. `ListParts`: if any part in `1..partCount` is missing, reject with `UPLOAD_INCOMPLETE`. The video stays `uploading` and is resumable.
3. If any listed part has an unexpected size (every part `n < partCount` must be exactly `partSize`, the last one `size_bytes − (partCount − 1) × partSize`, which also guarantees the sum), reject with `UPLOAD_SIZE_MISMATCH`. Without this check, S3 rejects parts below 5 MiB with `EntityTooSmall` and the answer would be a 500. The video stays `uploading`, so the client can re-PUT a part or abort.
4. `CompleteMultipartUpload` with the parts sorted ascending by `PartNumber`. Concurrency: if it fails with `NoSuchUpload` (a concurrent `complete`/abort/sweep already consumed the upload), re-read the row. Whether it is no longer `uploading` or still `uploading` (a concurrent `complete` consumed the upload but has not committed yet), reject with `INVALID_VIDEO_STATE` (409), never a 500. The step-6 transition is a conditional update (`WHERE id = :id AND processing_status = 'uploading'`). If it affects 0 rows, the answer is also `INVALID_VIDEO_STATE`.
5. `HeadObject` on `source_key` (backstop). If `ContentLength` ≠ `size_bytes` or > `VIDEO_MAX_UPLOAD_BYTES`, call `DeleteObject`, set `processing_status = 'failed'`, `failure_reason = 'UPLOAD_SIZE_MISMATCH'`, `upload_id = null`, and reject with `UPLOAD_SIZE_MISMATCH`.
6. Set `processing_status = 'processing'`, `upload_id = null`, and commit.
7. After the commit, enqueue `process-video` (see Events/Messages), bounded by a **3 s timeout** (`ENQUEUE_TIMEOUT_MS = 3000`, code constant). By design, BullMQ's `add` keeps waiting while Redis is unreachable instead of failing (bullmq v6 docs, "Failing fast when Redis is down"). The documented `enableOfflineQueue: false` cannot be used because the `QueueModule` connection is shared with the worker, which must keep the offline queue. So a timeout counts as an enqueue failure. If the enqueue throws or times out, the error is logged and **swallowed**, and the response is still 202. The row is already `processing`, and the maintenance sweep re-enqueues it (non-transactional dual write covered per `phase-03-videos/TD-01`, `phase-03-videos/TD-12`).
   **Deliberate exception to `.claude/rules/nestjs-services.md` ("catch must end with a throw").** This falls under the rule's own carve-out of converting an error into a valid domain result. The state change is already committed and cannot be retried by the client, because a second `complete` answers `INVALID_VIDEO_STATE`. Rethrowing would report a 500 for an upload that actually succeeded. Requirements:
   - log at `error` level, with `videoId`;
   - put a code comment at the catch that cites this spec;
   - add a unit test proving the 202 + log on enqueue failure;
   - add an integration test proving the sweep re-enqueues the orphaned row.

**Response 202:** `VideoResponse` with `processingStatus: 'processing'`.

**Error responses:**
- 400 VALIDATION_ERROR: `id` not a uuid
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: video does not exist **or** caller is not the owner
- 409 INVALID_VIDEO_STATE: `processing_status` ≠ `'uploading'` (this includes a second `complete` call)
- 409 UPLOAD_INCOMPLETE: parts missing. `message` names the missing part numbers (first 20, then `…`)
- 422 UPLOAD_SIZE_MISMATCH: listed parts or the stored object size ≠ declared `sizeBytes`, or the stored object exceeds the max

---

#### DELETE /videos/:id/upload (SI-03.11)

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

#### GET /videos/:id (SI-03.12)

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

#### GET /videos/:publicId/playback (SI-03.14)

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

#### GET /videos/:publicId/download (SI-03.15)

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
- `title`: optional string, trimmed, 1–255 characters (default derived from `fileName` in the service)
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
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded size does not match the declared size | `complete` when a listed part has an unexpected size or their sum ≠ `size_bytes` (video stays `uploading`), **or** the post-complete `HeadObject` size ≠ `size_bytes` / > max (object deleted, video → `failed` with `failure_reason = 'UPLOAD_SIZE_MISMATCH'`) (per `phase-03-videos/TD-06`) |
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

**Queue / scheduler:** `video-maintenance`. Job Scheduler id `video-maintenance-sweep`, repeat `{ every: VIDEO_SWEEP_INTERVAL_MS }`, job template `{ name: 'sweep', data: {}, opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } } }` (per `phase-03-videos/TD-12`). bullmq v6 has no legacy `repeat` API, so `upsertJobScheduler` is the only path (`library-refs.md` → bullmq).

**Payload:**

```json
{}
```

**Producer:** `WorkerModule` on bootstrap (`onApplicationBootstrap`) calls `queue.upsertJobScheduler('video-maintenance-sweep', { every: VIDEO_SWEEP_INTERVAL_MS }, { name: 'sweep', data: {}, opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } } })`. This is idempotent by scheduler id, so restarts and extra replicas do not stack schedulers. The API never declares it.
**Consumer:** `VideoMaintenanceConsumer` — `@Processor('video-maintenance', { concurrency: 1 })`, extends `WorkerHost`, in `WorkerModule`. Each tick is one job handled by one worker.
**Trigger:** every `VIDEO_SWEEP_INTERVAL_MS` (default 900000 = 15 min).
**Delivery semantics:** best-effort per tick (`attempts: 1`). A failed tick is simply covered by the next one. Per-row errors are logged and do not abort the batch. Finished ticks keep bounded retention (`removeOnComplete: { count: 50 }`, `removeOnFail: { count: 100 }`), because Redis runs with `noeviction` and a tick every 15 min would otherwise leave ~96 job hashes a day behind.

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

Tests reuse the production code path with small values, e.g. `VIDEO_MAX_UPLOAD_BYTES=12582912` (12 MiB) and `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880` (5 MiB), plus test-scoped buckets and queue prefix (per `phase-03-videos/TD-06`, `phase-03-videos/TD-14`).

**Test environment isolation (decided at leader gate G3a, not an SI-level choice).** Both Jest configs (`package.json` → `jest.setupFiles` and `test/jest-e2e.json` → `setupFiles`) load `dotenv/config`, i.e. the **same `.env` the containers use**. Without an override, the test process and the running `video-worker` container share `QUEUE_PREFIX=bull`: the container would consume jobs enqueued by tests (and process them against the production bucket names), and the test-booted `WorkerModule` would consume dev jobs. Mechanism:
- A setup file `src/test/setup-test-env.ts` is appended **after** `dotenv/config` in both `setupFiles` arrays. It force-assigns `process.env` before any module is compiled, so the real `registerAs` + Joi path runs unchanged (no config-provider override):
  - `QUEUE_PREFIX=test`;
  - `S3_VIDEOS_BUCKET=videos-test`, `S3_THUMBNAILS_BUCKET=thumbnails-test` (created by `minio-init`);
  - `VIDEO_MAX_UPLOAD_BYTES=12582912`, `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880`.
  
  Individual suites may still set narrower values (e.g. `VIDEO_MAX_ACTIVE_UPLOADS_PER_CHANNEL`) before compiling their module.
- Queue cleanup per suite: `obliterate({ force: true })` on the `test`-prefixed queues in `afterAll`, then close queues/workers so Jest exits without open handles.
- Known residual: Postgres stays shared between dev and tests (existing project model). The container's maintenance sweep only touches rows past the stale/grace thresholds (24 h / 15 min), and suites wipe `videos` via `cleanAllTables`, so test rows never live long enough to be swept.

**Compose (`nestjs-project/compose.yaml`)** — host keys use service names, with the single exception below (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`, `phase-03-videos/TD-14`, `phase-03-videos/TD-16`):
- `Dockerfile.dev`: `apt install -y … ffmpeg` (provides `ffprobe`). Shared by `nestjs-api` and `video-worker`, so it needs a one-time `docker compose build`.
- `redis`: `redis:8-alpine`, `redis-server --maxmemory-policy noeviction`, port `6379`, healthcheck `redis-cli ping`.
- `minio`: `cgr.dev/chainguard/minio@sha256:<digest>` (digest pinned at implementation), `server /data --address :9000 --console-address :9001`, `MINIO_ROOT_USER: ${S3_ACCESS_KEY:-streamtube}` / `MINIO_ROOT_PASSWORD: ${S3_SECRET_KEY:-streamtube-secret}` (defaults equal to `.env.example`, because `.env` is gitignored and a fresh clone has none; `minio-init` uses the same interpolation), ports `9000:9000` (same port inside and out) + `9001:9001`, named volume, network alias **`minio.localhost`**, readiness healthcheck (probe command validated against the pinned image).
- `minio-init`: one-shot service from the **`cgr.dev/chainguard/minio` image** (same digest as `minio`; the `minio-client` image has no `sh`), `entrypoint: ["sh", "-c"]` running an idempotent script: `mc alias set`, `mc mb -p` for `videos`, `thumbnails`, `videos-test`, `thumbnails-test`, and `mc anonymous set download` on both thumbnails buckets. **No bucket CORS**: `mc cors set` is not implemented on this MinIO build, and MinIO's default CORS already exposes `ETag` (per `phase-03-videos/TD-08` Note). Depends on `minio` healthy.
- `video-worker`: same build/volume as `nestjs-api`, `command` runs the worker entrypoint, `restart: unless-stopped`, `depends_on` `db`/`redis`/`minio` healthy + `minio-init` completed successfully. On a fresh clone it starts before `node_modules`, `.env` and the migrations exist, so the documented order is `cp .env.example .env` → `up -d` → `npm install` → `migration:run` → `docker compose restart video-worker`. It is the one application process that starts with the environment (queue consumer = infrastructure), an explicit carve-out to the `nestjs-project/CLAUDE.md` "never start the app" rule.
- `nestjs-api`: `depends_on` gains `redis`, `minio` (healthy) and `minio-init` (completed successfully). DoD commands stay unchanged (`docker compose exec nestjs-api …`).

**Docker Networking exception to record in root `CLAUDE.md`** (per `phase-03-videos/TD-16`): `S3_PUBLIC_ENDPOINT` is the one key allowed a `*.localhost` host (`http://minio.localhost:9000`). Inside containers it is a Compose network alias of the storage service, resolved by Docker DNS to that service and never to the container's own loopback, so the rule's intent (never point a container at itself) holds. It exists only because presigned URLs must be signed for a host that is also valid in the browser. Every other host key (`DB_HOST`, `REDIS_HOST`, `S3_ENDPOINT`) keeps the service name. curl hard-codes `*.localhost` to loopback even inside containers, so in-container probes of this host use Node `fetch` (or `mc ready` in the `minio` service), never curl (per `phase-03-videos/TD-16` Note). This exception is recorded in SI-03.2, together with the service that introduces it.

**Other doc/test fallout to cover in SIs:** `nestjs-project/CLAUDE.md` (services list, `redis-cli ping` + MinIO readiness probes, rebuild after `Dockerfile.dev` changes, worker entrypoint), and both `test` and `test:e2e` in `package.json` gaining `--runInBand` (CLAUDE.md claims e2e is already configured, but the script lacks it; the new integration suites share the `test` queue and `-test` buckets).

---

## Dependency Map

```
SI-03.1 (root) — config namespaces + env
└── SI-03.2 — depends on SI-03.1 (Compose interpolates MinIO credentials from the new S3_* keys)
    └── SI-03.3 — depends on SI-03.2 (test buckets created by minio-init)
        ├── SI-03.5 — depends on SI-03.3 (StorageModule; integration runs on the -test buckets)
        │   └── SI-03.17 — depends on SI-03.5 (media tools read fixtures through internal presigned URLs)
        └── SI-03.6 — depends on SI-03.3 (QueueModule; Jest queue prefix "test")

SI-03.4 (root, independent) — Video entity + migration + test fallout

SI-03.13 (root, independent) — @OptionalAuth guard

SI-03.7 — depends on SI-03.4 + SI-03.5 + SI-03.6 (videos domain foundation)
├── SI-03.8 — depends on SI-03.7 (POST /videos/uploads)
│   └── SI-03.9 — depends on SI-03.8 (part-urls; introduces findOwnedOrFail)
│       ├── SI-03.10 — depends on SI-03.9 (complete + enqueue)
│       ├── SI-03.11 — depends on SI-03.9 (DELETE upload)
│       └── SI-03.12 — depends on SI-03.9 (GET /videos/:id)
└── SI-03.14 — depends on SI-03.7 + SI-03.13 (playback, optional auth)
    └── SI-03.15 — depends on SI-03.14 (download reuses resolveViewable)

SI-03.16 — depends on SI-03.4 + SI-03.5 + SI-03.6 (WorkerModule + video-worker)
├── SI-03.18 — depends on SI-03.16 + SI-03.17 (process-video consumer)
└── SI-03.19 — depends on SI-03.16 (maintenance sweep + scheduler)

SI-03.20 — depends on SI-03.10 + SI-03.12 + SI-03.15 + SI-03.18 (full pipeline E2E)
└── SI-03.21 — depends on SI-03.20 + SI-03.11 + SI-03.19 (CLAUDE.md + openapi.json, last)
```

**Parallelizable after SI-03.7:** the owner-route chain (SI-03.8 → SI-03.12), the viewer chain (SI-03.13 → SI-03.15) and the worker chain (SI-03.16 → SI-03.19, with SI-03.17 startable right after SI-03.5) touch disjoint files, except `src/videos/videos.service.ts` / `videos.controller.ts`, which the owner and viewer chains both extend.

---

## Deliverables

- [x] SI-03.1 — Infra: dependências, namespaces de configuração e variáveis de ambiente
- [x] SI-03.2 — Infra: FFmpeg na imagem dev e serviços redis, minio e minio-init no Compose
- [x] SI-03.3 — Infra: isolamento do ambiente de teste e `--runInBand` no `test:e2e`
- [x] SI-03.4 — Entidade `Video`, migration `CreateVideos` e ajustes nos testes existentes
- [x] SI-03.5 — Módulo de storage (adapter S3 com client interno e público)
- [x] SI-03.6 — Módulo de fila (BullMQ) compartilhado entre API e worker
- [x] SI-03.7 — Fundações do domínio de vídeos (exceções, `publicId`, resposta e lookup de canal)
- [x] SI-03.8 — Endpoint POST /videos/uploads
- [x] SI-03.9 — Endpoint POST /videos/:id/upload/part-urls
- [x] SI-03.10 — Endpoint POST /videos/:id/upload/complete
- [x] SI-03.11 — Endpoint DELETE /videos/:id/upload
- [x] SI-03.12 — Endpoint GET /videos/:id
- [x] SI-03.13 — Guard de autenticação opcional (`@OptionalAuth`)
- [x] SI-03.14 — Endpoint GET /videos/:publicId/playback
- [x] SI-03.15 — Endpoint GET /videos/:publicId/download
- [x] SI-03.16 — Infra: `WorkerModule`, entrypoint `src/worker.ts` e serviço `video-worker`
- [x] SI-03.17 — Ferramentas de mídia: wrapper `ffprobe`/`ffmpeg` e fixtures
- [x] SI-03.18 — Consumer `process-video` (metadados e thumbnail)
- [x] SI-03.19 — Varredura de manutenção (`video-maintenance`)
- [x] SI-03.20 — E2E do pipeline completo (upload → processamento → streaming/download)
- [x] SI-03.21 — Documentação: `CLAUDE.md` (raiz e `nestjs-project`) e `openapi.json`

**Full test suites:**

- [x] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [x] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [x] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
