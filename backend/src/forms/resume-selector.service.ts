import {Injectable} from '@nestjs/common';
import {JobAnswerContext} from './answering.types';
import {ResumeProfile} from '../profile/profile.types';

export interface ResumeSelection {
  resume: ResumeProfile | null;
  confidence: 'high' | 'medium' | 'low' | null;
  reason: string;
  scores: Record<string, number>;
}

const TITLE_SIGNALS: Record<string, RegExp> = {
  fullstack: /full[\s-]?stack|mern|mean stack|node(?:\.js)?|nest(?:js)?|react|next(?:\.js)?|front[\s-]?end|back[\s-]?end|web developer/i,
  ai: /\bai\b|artificial intelligence|machine[\s-]?learning|\bml\b|llm|rag|nlp|computer vision|agentic|automation engineer/i,
  devops: /dev[\s-]?ops|sre|site reliability|platform engineer|cloud engineer|infrastructure|kubernetes|mlops/i,
  python: /python|django|fastapi|flask|data engineer/i,
  mobile: /flutter|dart|react native|android|ios|kotlin|swift|mobile/i,
  dotnet: /asp\.?net|\.net|dotnet|c#|blazor/i
};

const UNSUPPORTED = /\bjava\b|\bphp\b|laravel|wordpress|golang|\bruby\b|\brust\b|\bsalesforce\b|\bseo\b|\bmarketing\b|\baccountant\b/i;

@Injectable()
export class ResumeSelectorService {
  /**
   * **Summary:** Ranks the resume catalog against a job's role and skills and avoids selecting a weak or out-of-scope resume.
   * **Inputs:** `job` contains the title and description; `catalog` contains approved resume profiles.
   * **Returns:** The selected resume, confidence and reason, or no resume when the match is unreliable, plus all scores.
   */
  select(job: JobAnswerContext, catalog: ResumeProfile[]): ResumeSelection {
    const title = job.title || '';
    const body = `${title}\n${job.description}`;
    const scores: Record<string, number> = {};
    for (const resume of catalog) {
      const titleScore = TITLE_SIGNALS[resume.id]?.test(title) ? 10 : 0;
      const skillScore = Math.min(8, resume.skills.reduce((score, skill) =>
        score + (new RegExp(`\\b${this.escape(skill).replace(/\\ /g, '\\s+')}\\b`, 'i').test(body) ? 1 : 0), 0));
      scores[resume.id] = titleScore + skillScore;
    }
    const ranked = [...catalog].sort((a, b) => scores[b.id] - scores[a.id]);
    const top = ranked[0];
    const second = ranked[1];
    if (!top || scores[top.id] < 3) return {resume: null, confidence: null, reason: 'No reliable resume match.', scores};
    if (UNSUPPORTED.test(title) && scores[top.id] < 10) {
      return {resume: null, confidence: null, reason: 'Role appears outside the resume catalog.', scores};
    }
    const margin = scores[top.id] - (second ? scores[second.id] : 0);
    const confidence = scores[top.id] >= 10 && margin >= 4 ? 'high' : margin >= 2 ? 'medium' : 'low';
    return {
      resume: top,
      confidence,
      reason: `Selected ${top.id} from role signals and ${scores[top.id] - (TITLE_SIGNALS[top.id]?.test(title) ? 10 : 0)} matching skill(s).`,
      scores
    };
  }

  /**
   * **Summary:** Escapes a resume skill for safe matching against job text while preserving flexible whitespace.
   * **Inputs:** `value` is the literal skill name.
   * **Returns:** The regular-expression-safe skill text.
   */
  private escape(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, ' ');
  }
}
