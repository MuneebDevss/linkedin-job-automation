import {Injectable} from '@nestjs/common';
import {GoogleFormsAdapter} from './google-forms.adapter';
import {FormPlatformAdapter} from './form-platform-adapter.interface';

@Injectable()
export class FormAdapterRegistryService {
  private readonly adapters: FormPlatformAdapter[];

  /**
   * **Summary:** Creates the platform registry with every form adapter supported by the application.
   * **Inputs:** `googleForms` handles Google Forms application destinations.
   * **Returns:** A registry instance ready to select an adapter for a form URL.
   */
  constructor(googleForms: GoogleFormsAdapter) {
    this.adapters = [googleForms];
  }

  /**
   * **Summary:** Selects the form-platform adapter capable of processing a given application URL.
   * **Inputs:** `url` is the application-form destination to classify.
   * **Returns:** The supporting adapter, or `null` when the platform is unsupported.
   */
  forUrl(url: string): FormPlatformAdapter | null {
    return this.adapters.find(adapter => adapter.supports(url)) || null;
  }
}
