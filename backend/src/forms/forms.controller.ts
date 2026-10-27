import {Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards} from '@nestjs/common';
import {ApiKeyGuard} from '../common/api-key.guard';
import {AnswerEngineService} from './answer-engine.service';
import {GenerateAnswersDto} from './dto/generate-answers.dto';
import {FormAuthenticationService} from './automation/form-authentication.service';

@Controller('api/forms')
@UseGuards(ApiKeyGuard)
export class FormsController {
  constructor(
    private readonly answers: AnswerEngineService,
    private readonly authentication: FormAuthenticationService
  ) {}

  @Post('answers')
  @HttpCode(HttpStatus.OK)
  generate(@Body() input: GenerateAnswersDto) {
    return this.answers.generate(input);
  }

  @Get('auth/status')
  authenticationStatus() {
    return this.authentication.status();
  }

  @Post('auth/google')
  @HttpCode(HttpStatus.OK)
  authenticateGoogle() {
    return this.authentication.authenticate();
  }

  @Post('auth/session')
  @HttpCode(HttpStatus.OK)
  authenticateSession() {
    return this.authentication.authenticate();
  }
}
