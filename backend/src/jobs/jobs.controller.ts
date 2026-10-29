import {Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards} from '@nestjs/common';
import {ApiKeyGuard} from '../common/api-key.guard';
import {ProcessJobDto} from './dto/process-job.dto';
import {JobsService} from './jobs.service';

@Controller('api/jobs')
@UseGuards(ApiKeyGuard)
export class JobsController {
  /**
   * **Summary:** Creates the protected jobs API controller with access to the job-processing workflow.
   * **Inputs:** `jobs` coordinates classification, deduplication, and application delivery.
   * **Returns:** A controller instance ready to process and retrieve applications.
   */
  constructor(private readonly jobs: JobsService) {}

  /**
   * **Summary:** Processes a captured job post and starts each applicable idempotent application workflow.
   * **Inputs:** `input` contains the captured post, source URL, links, and timestamp.
   * **Returns:** The application identity, classification, normalized destinations, and workflow outcomes.
   */
  @Post('process')
  @HttpCode(HttpStatus.OK)
  process(@Body() input: ProcessJobDto) {
    return this.jobs.process(input);
  }

  /**
   * **Summary:** Retrieves a previously processed application and the current state of its delivery workflows.
   * **Inputs:** `applicationId` is the stable identifier returned when the job was processed.
   * **Returns:** The application summary and workflows.
   */
  @Get(':applicationId')
  get(@Param('applicationId') applicationId: string) {
    return this.jobs.get(applicationId);
  }

  /** Retries only Google Sheets synchronization; application workflows are never re-executed. */
  @Post(':applicationId/sync')
  @HttpCode(HttpStatus.OK)
  sync(@Param('applicationId') applicationId: string) {
    return this.jobs.retrySheetSync(applicationId);
  }
}
