import type { ConfigType } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import type databaseConfig from '../config/database.config';

/**
 * TypeORM root options shared by every Nest entrypoint (API and worker), so the
 * connection parameters live in one place. Entities come from each module's
 * `TypeOrmModule.forFeature` (`autoLoadEntities`); the schema comes from migrations.
 */
export function buildTypeOrmOptions(
  dbConfig: ConfigType<typeof databaseConfig>,
): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  };
}
