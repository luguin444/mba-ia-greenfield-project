import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1795641136433 implements MigrationInterface {
  name = 'CreateVideos1795641136433';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_processing_status_enum" AS ENUM('uploading', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_publication_status_enum" AS ENUM('draft')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(11) NOT NULL, "title" character varying(255) NOT NULL, "channel_id" uuid NOT NULL, "processing_status" "public"."videos_processing_status_enum" NOT NULL DEFAULT 'uploading', "publication_status" "public"."videos_publication_status_enum" NOT NULL DEFAULT 'draft', "failure_reason" character varying(64), "original_filename" character varying(255) NOT NULL, "mime_type" character varying(127) NOT NULL, "size_bytes" bigint NOT NULL, "upload_id" text, "upload_part_size_bytes" bigint NOT NULL, "source_key" character varying(255) NOT NULL, "thumbnail_key" character varying(255), "duration_seconds" double precision, "width" integer, "height" integer, "video_codec" character varying(64), "audio_codec" character varying(64), "format_name" character varying(128), "processed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8bcec1c46e7285dd2a30ea58a2" ON "videos" ("processing_status", "updated_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bee076e56ba6ea95ab5d6f681b" ON "videos" ("channel_id", "processing_status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_39a1f0fe7991162aace659078e" ON "videos" ("public_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_39a1f0fe7991162aace659078e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bee076e56ba6ea95ab5d6f681b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8bcec1c46e7285dd2a30ea58a2"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(
      `DROP TYPE "public"."videos_publication_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."videos_processing_status_enum"`,
    );
  }
}
