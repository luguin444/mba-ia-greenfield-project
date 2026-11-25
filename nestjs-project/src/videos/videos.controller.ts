import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
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
}
