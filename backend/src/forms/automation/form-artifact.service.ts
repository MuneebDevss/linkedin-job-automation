import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Page} from 'playwright';
import {AppConfiguration} from '../../config/app.config';

@Injectable()
export class FormArtifactService {
  /**
   * **Summary:** Creates the artifact service using the configured location for form-automation evidence.
   * **Inputs:** `config` provides the directory where job artifacts are stored.
   * **Returns:** An artifact service instance ready to capture form screenshots.
   */
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  /**
   * **Summary:** Captures a full-page screenshot for troubleshooting or reviewing a form-automation job.
   * **Inputs:** `page` is the current browser page; `jobId` groups the artifact; `label` describes the captured state.
   * **Returns:** The saved screenshot path, or `null` when the artifact could not be created.
   */
  async screenshot(page: Page, jobId: string, label: string): Promise<string | null> {
    const directory = join(
      this.config.get('formArtifactsDirectory', {infer: true}),
      jobId.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120)
    );
    try {
      await mkdir(directory, {recursive: true});
      const path = join(directory, `${Date.now()}-${label.replace(/[^a-zA-Z0-9_.-]+/g, '_')}.png`);
      await page.screenshot({path, fullPage: true});
      return path;
    } catch {
      return null;
    }
  }
}
