import {Module} from '@nestjs/common';
import {ProfileModule} from '../profile/profile.module';
import {AnswerEngineService} from './answer-engine.service';
import {FORM_PROCESSOR} from './form-processor.interface';
import {FormsController} from './forms.controller';
import {GeminiService} from './gemini.service';
import {PlaceholderFormProcessor} from './placeholder-form.processor';
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
    {provide: FORM_PROCESSOR, useClass: PlaceholderFormProcessor}
  ],
  exports: [FORM_PROCESSOR, AnswerEngineService]
})
export class FormsModule {}
