import {Injectable} from '@nestjs/common';
import {FormProcessingInput, FormProcessingResult, FormProcessor} from './form-processor.interface';

@Injectable()
export class PlaceholderFormProcessor implements FormProcessor {
  async process(_input: FormProcessingInput): Promise<FormProcessingResult> {
    throw new Error('Form automation is intentionally not implemented in this patch.');
  }
}
