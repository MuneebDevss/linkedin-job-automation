export interface FormProcessingInput {
  jobId: string;
  applicationId: string;
  formUrls: string[];
  text: string;
}

export interface FormProcessingResult {
  status: 'completed' | 'needs_manual_action' | 'failed';
  details?: unknown;
}

export interface FormProcessor {
  process(input: FormProcessingInput): Promise<FormProcessingResult>;
}

export const FORM_PROCESSOR = Symbol('FORM_PROCESSOR');
