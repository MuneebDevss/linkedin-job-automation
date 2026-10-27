import {Module} from '@nestjs/common';
import {ClassificationModule} from '../classification/classification.module';
import {ApiKeyGuard} from '../common/api-key.guard';
import {IdentityModule} from '../identity/identity.module';
import {N8nModule} from '../n8n/n8n.module';
import {UrlModule} from '../url/url.module';
import {JobsController} from './jobs.controller';
import {JobsService} from './jobs.service';

@Module({
  imports: [UrlModule, ClassificationModule, IdentityModule, N8nModule],
  controllers: [JobsController],
  providers: [JobsService, ApiKeyGuard]
})
export class JobsModule {}
