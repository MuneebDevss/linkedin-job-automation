import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Page} from 'playwright';
import {AppConfiguration} from '../../config/app.config';

@Injectable()
export class FormArtifactService {
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

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
