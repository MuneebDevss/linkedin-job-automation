import {Module} from '@nestjs/common';
import {ProfileModule} from '../profile/profile.module';
import {AnswerEngineService} from './answer-engine.service';
import {FormAdapterRegistryService} from './automation/form-adapter-registry.service';
import {FormArtifactService} from './automation/form-artifact.service';
import {GoogleFormsAdapter} from './automation/google-forms.adapter';
import {PlaywrightBrowserService} from './automation/playwright-browser.service';
import {PlaywrightFormProcessor} from './automation/playwright-form.processor';
import {AuthenticationStateStoreService} from './automation/authentication-state-store.service';
import {FormAuthenticationService} from './automation/form-authentication.service';
import {FORM_PROCESSOR} from './form-processor.interface';
import {FormsController} from './forms.controller';
import {GeminiService} from './gemini.service';
import {QuestionMatcherService} from './question-matcher.service';
import {ResumeSelectorService} from './resume-selector.service';

@Module({
  imports: [ProfileModule],
  controllers: [FormsController],
  providers: [
    AnswerEngineService,
    GeminiService,
    QuestionMatcherService,
    ResumeSelectorService,
    AuthenticationStateStoreService,
    FormAuthenticationService,
    GoogleFormsAdapter,
    FormAdapterRegistryService,
    FormArtifactService,
    PlaywrightBrowserService,
    PlaywrightFormProcessor,
    {provide: FORM_PROCESSOR, useExisting: PlaywrightFormProcessor}
  ],
  exports: [FORM_PROCESSOR, AnswerEngineService]
})
export class FormsModule {}
