import {Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards} from '@nestjs/common';
import {ApiKeyGuard} from '../common/api-key.guard';
import {ProcessJobDto} from './dto/process-job.dto';
import {JobsService} from './jobs.service';
import {
  ApplicationListQueryDto, CreateBatchDto, EventsQueryDto, PageQueryDto, RetryWorkflowDto, WorkflowCallbackDto
} from './dto/jobs-dashboard.dto';

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

  @Post('batches')
  @HttpCode(HttpStatus.ACCEPTED)
  createBatch(@Body() input: CreateBatchDto) {
    return this.jobs.createBatch(input);
  }

  @Get('dashboard')
  dashboard() {
    return this.jobs.dashboard();
  }

  @Get('health')
  health() {
    return this.jobs.health();
  }

  @Post('import/google-sheets')
  @HttpCode(HttpStatus.OK)
  importGoogleSheets() {
    return this.jobs.importGoogleSheets();
  }

  @Get('applications')
  applications(@Query() query: ApplicationListQueryDto) {
    return this.jobs.listApplications(query);
  }

  @Get('batches')
  batches(@Query() query: PageQueryDto) {
    return this.jobs.listBatches(query);
  }

  @Get('batches/:batchId')
  batch(@Param('batchId') batchId: string) {
    return this.jobs.getBatch(batchId);
  }

  @Post('batches/:batchId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retryBatch(@Param('batchId') batchId: string) {
    return this.jobs.retryBatch(batchId);
  }

  @Get('failures')
  failures() {
    return this.jobs.failures();
  }

  @Get('events')
  events(@Query() query: EventsQueryDto) {
    return this.jobs.events(query);
  }

  @Post('workflows/:workflowId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retryWorkflow(@Param('workflowId') workflowId: string, @Body() input: RetryWorkflowDto) {
    return this.jobs.retryWorkflow(workflowId, input.idempotencyKey);
  }

  @Post('workflows/:workflowId/callback')
  @HttpCode(HttpStatus.OK)
  workflowCallback(@Param('workflowId') workflowId: string, @Body() input: WorkflowCallbackDto) {
    return this.jobs.workflowCallback(workflowId, input);
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

}
