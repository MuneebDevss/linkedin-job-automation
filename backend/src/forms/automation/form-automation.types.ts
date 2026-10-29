import {AnswerValue, FieldType, FormQuestion, GeneratedAnswer} from '../answering.types';

export type FormControlKind = FieldType | 'file' | 'unsupported';

export interface ExtractedFormQuestion extends Omit<FormQuestion, 'type'> {
  type: FieldType;
  controlKind: FormControlKind;
  containerIndex: number;
  pageIndex: number;
  legalDeclaration: boolean;
  constraints: {
    min?: string;
    max?: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    accept?: string;
  };
}

export interface FormPageSnapshot {
  title: string;
  pageIndex: number;
  signature: string;
  questions: ExtractedFormQuestion[];
}

export interface FormBlocker {
  code: 'captcha' | 'authentication_required' | 'form_closed' | 'access_denied';
  message: string;
}

export interface FormAction {
  kind: 'next' | 'submit' | 'none';
  label?: string;
}

export interface FillRecord {
  questionId: string;
  label: string;
  fieldType: FieldType | 'file';
  required: boolean;
  source: GeneratedAnswer['provenance']['source'] | 'resume' | 'application_document' | 'configured_consent';
  confidence: GeneratedAnswer['confidence'] | 'high';
  value: AnswerValue | string;
}

export interface FormIssue {
  questionId?: string;
  label?: string;
  code: string;
  message: string;
  required?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  issues: FormIssue[];
}

export interface SubmissionEvidence {
  kind: 'confirmation_message' | 'confirmation_container';
  message: string;
  url: string;
}
