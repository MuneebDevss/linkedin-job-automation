import {Type} from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString,
  Matches, MaxLength, ValidateNested
} from 'class-validator';
import {FIELD_TYPES, FieldType, SalaryPeriod, Seniority} from '../answering.types';

const SENIORITIES: Seniority[] = ['intern', 'entry', 'mid', 'senior', 'lead'];
const SALARY_PERIODS: SalaryPeriod[] = ['monthly', 'annual'];

export class FormQuestionDto {
  @IsString()
  @MaxLength(200)
  id!: string;

  @IsString()
  @MaxLength(1000)
  label!: string;

  @IsIn(FIELD_TYPES)
  type!: FieldType;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({each: true})
  @MaxLength(500, {each: true})
  options?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  placeholder?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsIn(SALARY_PERIODS)
  salaryPeriod?: SalaryPeriod;
}

export class JobAnswerContextDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsString()
  @MaxLength(50000)
  description!: string;

  @IsOptional()
  @IsIn(SENIORITIES)
  seniority?: Seniority;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency?: string;
}

export class GenerateAnswersDto {
  @ValidateNested()
  @Type(() => JobAnswerContextDto)
  job!: JobAnswerContextDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({each: true})
  @Type(() => FormQuestionDto)
  questions!: FormQuestionDto[];
}
