import {Injectable} from '@nestjs/common';
import {FieldType, FormQuestion} from './answering.types';

interface FieldDefinition {
  key: string;
  aliases: string[];
  patterns: RegExp[];
  types?: FieldType[];
}

export interface QuestionMatch {
  fieldKey: string;
  confidence: number;
  normalizedQuestion: string;
}

const DEFINITIONS: FieldDefinition[] = [
  {
    key: 'firstName', aliases: ['first name', 'given name'],
    patterns: [/^(?:your |applicant |candidate )?(?:first|given) name$/]
  },
  {
    key: 'lastName', aliases: ['last name', 'family name', 'surname'],
    patterns: [/^(?:your |applicant |candidate )?(?:last|family) name$/, /^surname$/]
  },
  {
    key: 'name', aliases: ['full name', 'applicant name', 'candidate name', 'legal name', 'name'],
    patterns: [/^(?:your )?(?:full |applicant |candidate |legal )?name$/]
  },
  {
    key: 'email', aliases: ['email', 'email address', 'e mail address', 'contact email'],
    patterns: [/(?:email|e mail)(?: address)?$/]
  },
  {
    key: 'phone', aliases: ['phone', 'phone number', 'mobile', 'mobile number', 'contact number'],
    patterns: [/(?:phone|mobile|contact)(?: number)?$/]
  },
  {
    key: 'linkedin', aliases: ['linkedin', 'linkedin url', 'linkedin profile', 'linkedin profile url'],
    patterns: [/linkedin.*(?:url|profile|link)?$/]
  },
  {
    key: 'github', aliases: ['github', 'github url', 'github profile', 'github profile url'],
    patterns: [/github.*(?:url|profile|link)?$/]
  },
  {
    key: 'location', aliases: ['location', 'current location', 'city', 'current city', 'where are you located'],
    patterns: [/(?:current )?(?:location|city|residence)$/]
  },
  {
    key: 'university', aliases: ['university', 'college', 'institution', 'school', 'university name'],
    patterns: [/(?:university|college|institution|school)(?: name)?$/]
  },
  {
    key: 'cgpa', aliases: ['cgpa', 'gpa', 'grade point average', 'cumulative gpa'],
    patterns: [/(?:cumulative )?(?:cgpa|gpa|grade point average)$/], types: ['number', 'text']
  },
  {
    key: 'employmentStatus', aliases: ['employment status', 'current employment status', 'currently employed'],
    patterns: [/(?:current )?employment status$/, /are you (?:currently )?employed/]
  },
  {
    key: 'availability', aliases: ['availability', 'available to start', 'start date', 'earliest start date', 'joining date'],
    patterns: [/(?:when|date).*(?:start|join|available)/, /(?:start|joining|availability) date$/]
  },
  {
    key: 'relocation', aliases: ['relocation', 'willing to relocate', 'can you relocate', 'open to relocation'],
    patterns: [/(?:willing|able|open).*(?:relocat)/, /relocation/], types: ['radio', 'select', 'checkbox', 'text']
  },
  {
    key: 'onsiteWork', aliases: ['willing to work onsite', 'comfortable working onsite', 'available for onsite work', 'can you work onsite'],
    patterns: [/(?:willing|comfortable|available|able).*(?:on[ -]?site|in office)/, /(?:on[ -]?site|in office).*(?:work|available)/],
    types: ['radio', 'select', 'checkbox', 'text']
  },
  {
    key: 'shiftAvailability', aliases: ['willing to work night shifts', 'night shift availability', 'flexible shifts', 'shift availability'],
    patterns: [/(?:willing|available|able).*(?:night|evening|different|rotating|flexible).*(?:shift|hours)/,
      /(?:night|evening|rotating) shift/], types: ['radio', 'select', 'checkbox', 'text']
  },
  {
    key: 'flexibleHours', aliases: ['flexible working hours', 'flexible work hours', 'flexible schedule'],
    patterns: [/(?:flexible|varying).*(?:working )?(?:hours|schedule)/], types: ['radio', 'select', 'checkbox', 'text']
  },
  {
    key: 'willingnessToLearn', aliases: ['willing to learn', 'eager to learn', 'open to learning new technologies'],
    patterns: [/(?:willing|eager|open).*(?:learn|new technolog)/], types: ['radio', 'select', 'checkbox', 'text', 'long_text']
  },
  {
    key: 'salaryNegotiable', aliases: ['is salary negotiable', 'salary flexibility', 'flexible salary expectations'],
    patterns: [/(?:salary|compensation).*(?:negotiable|flexib)/, /(?:negotiable|flexible).*(?:salary|compensation)/],
    types: ['radio', 'select', 'checkbox', 'text']
  },
  {
    key: 'workAuthorization', aliases: ['work authorization', 'authorized to work', 'legally authorized to work'],
    patterns: [/(?:legally )?authori[sz]ed to work/, /work authori[sz]ation/]
  },
  {
    key: 'yearsOfExperience', aliases: ['years of experience', 'total experience', 'professional experience'],
    patterns: [/(?:how many|number of|total)? ?years? of experience/, /professional experience/], types: ['number', 'text', 'select']
  },
  {
    key: 'salary', aliases: ['salary expectation', 'expected salary', 'desired salary', 'salary requirements', 'expected compensation', 'desired compensation', 'expected ctc'],
    patterns: [/(?:expected|desired|salary).*(?:salary|compensation|ctc|pay)/, /(?:salary|compensation) expectation/],
    types: ['number', 'text', 'radio', 'select']
  },
  {
    key: 'strengths', aliases: ['strengths', 'key strengths', 'core strengths', 'skills', 'key skills'],
    patterns: [/(?:key|core|top)? ?(?:strengths|skills)$/], types: ['text', 'long_text', 'checkbox', 'select']
  },
  {
    key: 'motivation', aliases: ['why us', 'motivation', 'why are you interested in this role', 'why do you want to work here'],
    patterns: [/why.*(?:join|role|company|work|interested|apply)/, /motivation/], types: ['text', 'long_text']
  },
  {
    key: 'professionalSummary', aliases: ['tell us about yourself', 'professional summary', 'brief introduction', 'about you'],
    patterns: [/(?:tell|describe).*(?:yourself|background)/, /professional summary/], types: ['text', 'long_text']
  }
];

@Injectable()
export class QuestionMatcherService {
  /**
   * **Summary:** Normalizes application-question wording so equivalent labels can be recognized despite formatting differences.
   * **Inputs:** `text` is the human-written label to normalize.
   * **Returns:** The normalized comparison text.
   */
  normalize(text: string): string {
    return text.normalize('NFKC').toLowerCase()
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\([^)]*(?:required|optional)[^)]*\)/g, ' ')
      .replace(/\b(?:required|optional)\b/g, ' ')
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}#+.]+/gu, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  /**
   * **Summary:** Maps a form question to the most likely verified profile field using exact aliases, business patterns, and token similarity.
   * **Inputs:** `question` contains the field label and answer type to classify.
   * **Returns:** The best field match and confidence, or `null` when no reliable definition fits.
   */
  match(question: FormQuestion): QuestionMatch | null {
    const normalizedQuestion = this.normalize(question.label);
    let best: QuestionMatch | null = null;
    for (const definition of DEFINITIONS) {
      if (definition.types && !definition.types.includes(question.type)) continue;
      const aliases = definition.aliases.map(alias => this.normalize(alias));
      let confidence = aliases.includes(normalizedQuestion) ? 1 : 0;
      if (!confidence && definition.patterns.some(pattern => pattern.test(normalizedQuestion))) confidence = 0.93;
      if (!confidence) {
        const tokens = new Set(normalizedQuestion.split(' '));
        const similarity = Math.max(...aliases.filter(alias => alias.includes(' ')).map(alias => {
          const expected = alias.split(' ');
          return expected.filter(token => tokens.has(token)).length / new Set([...tokens, ...expected]).size;
        }), 0);
        if (similarity >= 0.6) confidence = 0.75 + similarity * 0.15;
      }
      if (confidence && (!best || confidence > best.confidence)) {
        best = {fieldKey: definition.key, confidence, normalizedQuestion};
      }
    }
    return best;
  }
}
