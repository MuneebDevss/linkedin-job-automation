import {Body, Controller, HttpCode, HttpStatus, Post, UseGuards} from '@nestjs/common';
import {ApiKeyGuard} from '../common/api-key.guard';
import {AnswerEngineService} from './answer-engine.service';
import {GenerateAnswersDto} from './dto/generate-answers.dto';

@Controller('api/forms')
@UseGuards(ApiKeyGuard)
export class FormsController {
  constructor(private readonly answers: AnswerEngineService) {}

  @Post('answers')
  @HttpCode(HttpStatus.OK)
  generate(@Body() input: GenerateAnswersDto) {
    return this.answers.generate(input);
  }
}
