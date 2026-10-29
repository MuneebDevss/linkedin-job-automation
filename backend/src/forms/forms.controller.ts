import {Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards} from '@nestjs/common';
import {ApiKeyGuard} from '../common/api-key.guard';
import {AnswerEngineService} from './answer-engine.service';
import {GenerateAnswersDto} from './dto/generate-answers.dto';
import {FormAuthenticationService} from './automation/form-authentication.service';

@Controller('api/forms')
@UseGuards(ApiKeyGuard)
export class FormsController {
  /**
   * **Summary:** Creates the forms API controller with answer-generation and authentication workflow support.
   * **Inputs:** `answers` generates form responses; `authentication` manages reusable browser sign-in state.
   * **Returns:** A controller instance ready to serve protected form endpoints.
   */
  constructor(
    private readonly answers: AnswerEngineService,
    private readonly authentication: FormAuthenticationService
  ) {}

  /**
   * **Summary:** Generates reliable answers for a supplied job and its application-form questions.
   * **Inputs:** `input` contains the job context and questions submitted in the API request.
   * **Returns:** The generated answers, resume selection, conflicts, and source priority.
   */
  @Post('answers')
  @HttpCode(HttpStatus.OK)
  generate(@Body() input: GenerateAnswersDto) {
    return this.answers.generate(input);
  }

  /**
   * **Summary:** Exposes whether saved form authentication is available for automation.
   * **Inputs:** No parameters.
   * **Returns:** The current authentication-state status and metadata.
   */
  @Get('auth/status')
  authenticationStatus() {
    return this.authentication.status();
  }

  /**
   * **Summary:** Starts an interactive Google sign-in workflow and saves the resulting session for form automation.
   * **Inputs:** No parameters.
   * **Returns:** The completed authentication status and update time.
   */
  @Post('auth/google')
  @HttpCode(HttpStatus.OK)
  authenticateGoogle() {
    return this.authentication.authenticate();
  }

  /**
   * **Summary:** Starts the general interactive authentication workflow used by supported form providers.
   * **Inputs:** No parameters.
   * **Returns:** The completed authentication status and update time.
   */
  @Post('auth/session')
  @HttpCode(HttpStatus.OK)
  authenticateSession() {
    return this.authentication.authenticate();
  }
}
