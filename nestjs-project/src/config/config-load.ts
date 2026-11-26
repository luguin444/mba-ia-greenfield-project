import type { ConfigModuleOptions } from '@nestjs/config';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import mailConfig from './mail.config';
import queueConfig from './queue.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';
import videoConfig from './video.config';
import { envValidationSchema } from './env.validation';

/**
 * Config namespaces loaded by every Nest entrypoint (API and worker),
 * so both processes read the same validated configuration.
 */
export const configLoad = [
  appConfig,
  authConfig,
  databaseConfig,
  mailConfig,
  swaggerConfig,
  queueConfig,
  storageConfig,
  videoConfig,
];

/**
 * `ConfigModule.forRoot` options of every Nest entrypoint: same namespaces and
 * the same Joi validation, so the API and the worker fail fast on the same env.
 */
export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  load: configLoad,
  validationSchema: envValidationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
};
