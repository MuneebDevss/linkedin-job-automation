import {Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards} from '@nestjs/common';
import {ApiKeyGuard} from '../common/api-key.guard';
import {ProcessJobDto} from './dto/process-job.dto';
import {JobsService} from './jobs.service';

@Controller('api/jobs')
@UseGuards(ApiKeyGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('process')
  @HttpCode(HttpStatus.OK)
  process(@Body() input: ProcessJobDto) {
    return this.jobs.process(input);
  }

  @Get(':applicationId')
  get(@Param('applicationId') applicationId: string) {
    return this.jobs.get(applicationId);
  }
}
