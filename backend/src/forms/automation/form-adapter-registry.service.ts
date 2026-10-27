import {Injectable} from '@nestjs/common';
import {GoogleFormsAdapter} from './google-forms.adapter';
import {FormPlatformAdapter} from './form-platform-adapter.interface';

@Injectable()
export class FormAdapterRegistryService {
  private readonly adapters: FormPlatformAdapter[];

  constructor(googleForms: GoogleFormsAdapter) {
    this.adapters = [googleForms];
  }

  forUrl(url: string): FormPlatformAdapter | null {
    return this.adapters.find(adapter => adapter.supports(url)) || null;
  }
}
