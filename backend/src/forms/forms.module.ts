import {Module} from '@nestjs/common';
import {FORM_PROCESSOR} from './form-processor.interface';
import {PlaceholderFormProcessor} from './placeholder-form.processor';

@Module({providers: [{provide: FORM_PROCESSOR, useClass: PlaceholderFormProcessor}], exports: [FORM_PROCESSOR]})
export class FormsModule {}
