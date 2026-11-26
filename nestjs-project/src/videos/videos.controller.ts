import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { PartUrlsDto } from './dto/part-urls.dto';
import { SignedUrlResponseDto } from './dto/signed-url-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';

const ERROR_SCHEMA = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers the video as a draft in the caller's channel, opens an S3 multipart upload and returns the first batch (at most 100) of presigned part URLs. Video bytes go straight to storage, never through the API.",
  })
  @ApiResponse({
    status: 201,
    description: 'Upload started',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: 'The authenticated user has no channel (CHANNEL_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description:
      'Too many uploads in progress for this channel (ACTIVE_UPLOAD_LIMIT_REACHED)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 413,
    description: 'Video exceeds the maximum upload size (VIDEO_TOO_LARGE)',
    schema: ERROR_SCHEMA,
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign part URLs (resume an upload)',
    description:
      'Lists the parts already stored and signs the missing ones (the first 100, ascending), or exactly the requested `partNumbers`, which may be re-PUT. Also marks the upload as active for the maintenance sweep.',
  })
  @ApiResponse({
    status: 200,
    description: 'Parts already stored and newly signed part URLs',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed, or a part number is above partCount (INVALID_PART_NUMBER)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not uploading (INVALID_VIDEO_STATE)',
    schema: ERROR_SCHEMA,
  })
  async signPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videosService.signPartUrls(id, user.sub, dto);
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Closes the multipart upload from the parts stored in storage (no body; client ETags are not needed), checks every part size against the declared size, moves the video to `processing` and enqueues background processing.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing queued',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (id is not a uuid)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description:
      'The video is not uploading (INVALID_VIDEO_STATE), or parts are missing (UPLOAD_INCOMPLETE)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 422,
    description:
      'Stored part or object sizes do not match the declared size (UPLOAD_SIZE_MISMATCH)',
    schema: ERROR_SCHEMA,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.completeUpload(id, user.sub);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts the in-progress multipart upload, discarding the stored parts, and marks the video as failed (UPLOAD_ABORTED). Frees one active-upload slot of the channel.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (id is not a uuid)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'The video is not uploading (INVALID_VIDEO_STATE)',
    schema: ERROR_SCHEMA,
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.videosService.abortUpload(id, user.sub);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get one of my videos',
    description:
      'Returns the current status and metadata of a video owned by the caller. Used to poll processing after completing the upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'The video in its current status',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (id is not a uuid)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or not owned by the caller (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  async getOwned(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VideoResponseDto> {
    return this.videosService.getOwned(id, user.sub);
  }

  @Get(':publicId/playback')
  @OptionalAuth()
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a streaming URL for a video',
    description:
      'Authentication optional. Returns a short-lived presigned GET of the original file, so the `<video>` element streams it with HTTP Range (206) straight from storage. A draft video is visible only to its owner; anyone else gets the same 404 as a missing video.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL',
    type: SignedUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description:
      'An Authorization header was sent but the token is invalid or expired',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description:
      'No such video, malformed publicId, or not visible to the caller (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description:
      'Visible to the caller but not processed yet (VIDEO_NOT_READY)',
    schema: ERROR_SCHEMA,
  })
  async getPlaybackUrl(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
  ): Promise<SignedUrlResponseDto> {
    return this.videosService.getPlaybackUrl(publicId, user?.sub);
  }

  @Get(':publicId/download')
  @OptionalAuth()
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a download URL for a video',
    description:
      'Authentication optional. Returns a short-lived presigned GET of the original file; storage answers with `Content-Disposition: attachment` and the original file name. Same access rule as playback: a draft video is visible only to its owner; anyone else gets the same 404 as a missing video.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    type: SignedUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description:
      'An Authorization header was sent but the token is invalid or expired',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description:
      'No such video, malformed publicId, or not visible to the caller (VIDEO_NOT_FOUND)',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description:
      'Visible to the caller but not processed yet (VIDEO_NOT_READY)',
    schema: ERROR_SCHEMA,
  })
  async getDownloadUrl(
    @CurrentUser() user: JwtPayload | undefined,
    @Param('publicId') publicId: string,
  ): Promise<SignedUrlResponseDto> {
    return this.videosService.getDownloadUrl(publicId, user?.sub);
  }
}
