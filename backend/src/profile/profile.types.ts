import {AnswerValue, Confidence, FieldType, SalaryPeriod, Seniority} from '../forms/answering.types';

export interface SalaryBand {
  monthly: number | null;
  annual: number | null;
}

export interface VerifiedProfile {
  name: string;
  email: string;
  phone: string | null;
  linkedin: string;
  github: string;
  location: string | null;
  university: string | null;
  cgpa: number | null;
  employmentStatus: string | null;
  availability: {status: string | null; date: string | null};
  relocation: {willing: boolean | null; locations: string[]};
  yearsOfExperience: number | null;
  workAuthorization: string | null;
  strengths: string[];
  willing_to_work_onsite?: boolean;
  willing_to_relocate?: boolean;
  willing_to_work_night_shifts?: boolean;
  flexible_working_hours?: boolean;
  willing_to_learn?: boolean;
  salary_negotiable?: boolean;
  salaryExpectations: Record<Seniority, Record<string, SalaryBand>>;
  automationConsents?: {
    automaticSubmission: boolean;
    legalDeclarations: Record<string, boolean>;
  };
}

export interface ReusableAnswer {
  id: string;
  question: string;
  normalizedQuestion: string;
  fieldType: FieldType;
  answer: AnswerValue;
  confidence: Confidence;
  approved: boolean;
  fieldKey?: string;
  compatibility?: {
    roles?: string[];
    seniorities?: Seniority[];
    currencies?: string[];
    salaryPeriods?: SalaryPeriod[];
  };
  provenance: {source: string; model?: string; rationale?: string};
  createdAt: string;
  updatedAt: string;
}

export interface ResumeProfile {
  id: string;
  fileName: string;
  path: string;
  skills: string[];
  summary: string;
}

export interface ApplicationDocumentProfile {
  id: string;
  fileName: string;
  path: string;
  labels: string[];
}

export interface ProfileDocument {
  schemaVersion: 1;
  verified: VerifiedProfile;
  verification: Record<string, {source: string; status: 'verified'}>;
  approvedReusableAnswers: ReusableAnswer[];
  generatedSuggestions: ReusableAnswer[];
  resumeCatalog: ResumeProfile[];
  documentCatalog?: ApplicationDocumentProfile[];
}
