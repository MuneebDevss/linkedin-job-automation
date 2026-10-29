import {Transform} from 'class-transformer';
import {ArrayMaxSize, IsArray, IsISO8601, IsOptional, IsString, IsUrl, MaxLength, MinLength} from 'class-validator';

export class ProcessJobDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  @Transform(({value}) => typeof value === 'string' ? value.trim() : value)
  text!: string;

  @IsString()
  @IsOptional()
  @IsUrl({protocols: ['http', 'https'], require_protocol: true})
  @MaxLength(4096)
  @Transform(({value}) => typeof value === 'string' ? value.trim() || undefined : value)
  url?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({each: true})
  @MaxLength(4096, {each: true})
  links!: string[];

  @IsISO8601({strict: true})
  capturedAt!: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  @Transform(({value}) => typeof value === 'string' ? value.trim() || undefined : value)
  company?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  @Transform(({value}) => typeof value === 'string' ? value.trim() || undefined : value)
  role?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  @Transform(({value}) => typeof value === 'string' ? value.trim() || undefined : value)
  location?: string;
}
