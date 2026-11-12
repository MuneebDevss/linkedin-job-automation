import {Type} from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min,
  ValidateNested
} from 'class-validator';
import {ProcessJobDto} from './process-job.dto';

export class CreateBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({each: true})
  @Type(() => ProcessJobDto)
  entries!: ProcessJobDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  concurrency?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}

export class ApplicationListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['pending', 'processing', 'completed', 'needs_manual_action', 'failed', 'submission_unknown']) status?: string;
  @IsOptional() @IsIn(['email', 'form', 'email_and_form', 'needs_review']) method?: string;
  @IsOptional() @IsIn(['createdAt', 'updatedAt', 'company', 'role', 'status']) sort = 'updatedAt';
  @IsOptional() @IsIn(['asc', 'desc']) direction: 'asc' | 'desc' = 'desc';
}

export class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

export class EventsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) after = 0;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit = 100;
  @IsOptional() @IsString() @MaxLength(200) batchId?: string;
  @IsOptional() @IsString() @MaxLength(200) applicationId?: string;
}

export class RetryWorkflowDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}

export class WorkflowCallbackDto {
  @IsString() @IsIn(['completed', 'failed']) status!: 'completed' | 'failed';
  @IsString() @MaxLength(200) idempotencyKey!: string;
  @IsOptional() response?: unknown;
  @IsOptional() @IsString() @MaxLength(4000) error?: string;
}
