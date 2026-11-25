import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import mailConfig from './mail.config';
import queueConfig from './queue.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';
import videoConfig from './video.config';

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
