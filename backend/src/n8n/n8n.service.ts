import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {AppConfiguration} from '../config/app.config';
import {ProcessJobDto} from '../jobs/dto/process-job.dto';

@Injectable()
export class N8nService {
  private readonly logger = new Logger(N8nService.name);

  /**
   * **Summary:** Creates the n8n integration with its configured local webhook and request timeout.
   * **Inputs:** `config` provides the approved n8n endpoint and timeout.
   * **Returns:** An integration service instance ready to forward email workflows.
   */
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  /**
   * **Summary:** Sends a normalized job capture to the n8n email workflow and returns its response for durable recording.
   * **Inputs:** `payload` contains the captured job text, source, links, and timestamp.
   * **Returns:** The JSON or text response produced by the n8n workflow.
   */
  async forward(payload: ProcessJobDto): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.get('n8nTimeoutMs', {infer: true}));
    try {
      const response = await fetch(this.config.get('n8nWebhookUrl', {infer: true}), {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          text: payload.text,
          url: payload.url,
          links: payload.links,
          capturedAt: payload.capturedAt
        }),
        signal: controller.signal
      });
      const contentType = response.headers.get('content-type') || '';
      const body = contentType.includes('application/json') ? await response.json() : await response.text();
      if (!response.ok) throw new Error(`n8n returned HTTP ${response.status}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)}`);
      this.logger.log('n8n email workflow completed.');
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}
