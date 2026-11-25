import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';
import { MAX_SIGNED_PARTS_PER_BATCH } from '../videos.constants';

export class PartUrlsDto {
  /**
   * Parts to sign, even if already uploaded (a re-PUT overwrites the part).
   * When omitted, the first missing parts are signed in ascending order.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SIGNED_PARTS_PER_BATCH)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers?: number[];
}
