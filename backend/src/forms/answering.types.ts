export const FIELD_TYPES = ['text', 'number', 'date', 'radio', 'checkbox', 'select', 'long_text'] as const;
export type FieldType = typeof FIELD_TYPES[number];
export type AnswerValue = string | number | boolean | string[];
export type Confidence = 'high' | 'medium' | 'low';
export type AnswerSource = 'verified_profile' | 'approved_suggestion' | 'deterministic' | 'gemini' | 'unresolved';
export type Seniority = 'intern' | 'entry' | 'mid' | 'senior' | 'lead';
export type SalaryPeriod = 'monthly' | 'annual';

export interface FormQuestion {
  id: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  placeholder?: string;
  currency?: string;
  salaryPeriod?: SalaryPeriod;
}

export interface JobAnswerContext {
  title?: string;
  description: string;
  seniority?: Seniority;
  currency?: string;
}

export interface Provenance {
  source: AnswerSource;
  detail: string;
  profileField?: string;
  suggestionId?: string;
  model?: string;
}

export interface GeneratedAnswer {
  questionId: string;
  question: string;
  fieldType: FieldType;
  value: AnswerValue | null;
  confidence: Confidence;
  provenance: Provenance;
  matchedField?: string;
}

export interface AnswerConflict {
  questionId: string;
  keptSource: AnswerSource;
  ignoredSuggestionId: string;
  reason: string;
}
