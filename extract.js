// =====================================================================
// Job-post parser (n8n Code node, "Run once for all items")  v0.4.0
//
// What changed vs 0.3.2
//  - Role: 5-tier extraction (override > labelled line > hiring sentence
//    > top-of-post phrase scan) with a generic role-noun grammar instead of
//    a fixed keyword whitelist. Multi-role posts are supported.
//  - Resume: score-based (title signals + capped body signals), with
//    confidence, runner-up, "unsupported stack" guard and manual override.
//  - Application ID: SAME app-v1 format/normalisation, but fed by better
//    inputs (recipient choice, more cities/deadline formats). No hard
//    throw by default: returns ok:false + reviewReasons instead.
// =====================================================================

const CONFIG = {
  throwWhenNoApplicationId: false, // true = old behaviour (throw)
  resumeDir: '/files/resumes'
};

const profile = {
  name: 'Muneeb Ur Rehman',
  email: 'munib.urehmann@gmail.com',
  github: 'github.com/MuneebDevss',
  linkedin: 'linkedin.com/in/muneeb-ur-rehman-971b42313/'
};

// -------------------- Input --------------------

const b = $json.body || {};

if (
  typeof b.text !== 'string' ||
  !b.text.trim() ||
  b.text.length > 50000
) {
  throw new Error('Provide post text (1–50,000 characters).');
}

const text = b.text.trim();

// NFKC turns Unicode "bold/italic" letters (𝐀𝐈 𝐒𝐨𝐥𝐮𝐭𝐢𝐨𝐧𝐬) into plain ASCII.
const rawText = text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');

// Markdown links -> their label; bold markers removed. URLs/emails are
// still read from rawText so nothing is lost.
const normalizedText = rawText
  .replace(/\r\n?/g, '\n')
  .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
  .replace(/\*\*|__/g, '');

const lines = normalizedText
  .split('\n')
  .map(line => line.replace(/[ \t]+/g, ' ').trim())
  .filter(Boolean);

const stripLead = s => s.replace(/^[^\p{L}\p{N}.#+]+/u, '').trim();
const isHashtagOnly = s => /^(?:#[\p{L}\p{N}_]+\s*)+$/u.test(s);
const isBullet = s => /^[-•*·▪●◦‣✔✅☑➤➢►]/u.test(s);

// -------------------- Emails and links --------------------

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

const deobfuscated = rawText
  .replace(/\s*[\[(<{]\s*at\s*[\])>}]\s*/gi, '@')
  .replace(/\s*[\[(<{]\s*dot\s*[\])>}]\s*/gi, '.');

const emails = [
  ...new Set(
    (deobfuscated.match(EMAIL_RE) || [])
      .map(email => email.replace(/^[.]+|[.]+$/g, '').toLowerCase())
      .filter(email => !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(email))
  )
];

const rawLinks = [
  ...(Array.isArray(b.links)
    ? b.links.filter(link => typeof link === 'string')
    : []),
  ...(rawText.match(/https?:\/\/[^\s<>"'`)\]]+/gi) || [])
];

const links = [
  ...new Set(rawLinks.map(link => link.replace(/[.,;:!?]+$/, '')))
]
  .filter(link => /^https?:\/\//i.test(link))
  // LinkedIn hashtag / search / feed links are never an application target
  .filter(link => !/linkedin\.com\/(?:search|feed|hashtag)/i.test(link));

for (const link of Array.isArray(b.links) ? b.links : []) {
  if (typeof link === 'string' && /^mailto:/i.test(link)) {
    const address = link.slice(7).split('?')[0].toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && !emails.includes(address)) {
      emails.push(address);
    }
  }
}

const FORM_RE = /forms\.gle|docs\.google\.com\/forms|forms\.office\.com|typeform\.com|tally\.so|airtable\.com\/shr|jotform|greenhouse\.io|lever\.co|ashbyhq\.com|evahires\.com\/jobs|workable\.com|smartrecruiters|bamboohr|breezy\.hr|recruitee|zohorecruit|jazzhr|myworkdayjobs|workday|\/apply\b|\/application\b/i;
const formCandidates = links.filter(link => FORM_RE.test(link));

// Pick ONE recipient when the post lists several emails.
function chooseApplicationEmail() {
  if (typeof b.applyEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.applyEmail.trim())) {
    return { email: b.applyEmail.trim().toLowerCase(), reason: 'provided' };
  }
  if (emails.length === 1) return { email: emails[0], reason: 'only email in post' };
  if (!emails.length) return { email: null, reason: null };

  const applyWords = /\b(?:apply|send|submit|forward|share|email|e-mail|mail|cv|resume|résumé|application)\b/i;
  const onApplyLine = emails.filter(e =>
    lines.some(l => l.toLowerCase().includes(e) && applyWords.test(l))
  );
  if (onApplyLine.length === 1) return { email: onApplyLine[0], reason: 'on an apply/send line' };

  const pool = onApplyLine.length ? onApplyLine : emails;
  const hrLike = pool.filter(e =>
    /^(?:hr|careers?|jobs?|recruit(?:ment|er|ing)?|talent|hiring|apply|resumes?|cv)(?:[._-]|@)/.test(e)
  );
  if (hrLike.length === 1) return { email: hrLike[0], reason: 'HR/careers-style address' };

  return { email: null, reason: null };
}

const { email: applicationEmail, reason: applicationEmailReason } = chooseApplicationEmail();

// -------------------- Shared role vocabulary --------------------

const NOUN = '(?:developers?|engineers?|programmers?|architects?|interns?|internships?|trainees?|scientists?|analysts?|administrators?|specialists?|consultants?|designers?|testers?|leads?|managers?|executives?|officers?|associates?|coordinators?|technicians?|devops)';
const NOUN_RE = new RegExp(`(?<![\\p{L}\\p{N}])${NOUN}(?![\\p{L}\\p{N}])`, 'iu');
const TOKEN = `(?:\\.?[\\p{L}\\p{N}][\\p{L}\\p{N}.+#&/'’-]*|[/&+])`;
const PHRASE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])((?:${TOKEN}\\s+){0,6}?)` +
  `(${NOUN}(?![\\p{L}\\p{N}])(?:(?:\\s*[/&]\\s*|\\s+)${NOUN}(?![\\p{L}\\p{N}]))*)`,
  'giu'
);

const STOP = new Set([
  '', 'we', "we're", 'are', 'is', 'be', 'hiring', 'hire', 'hires', 'recruiting',
  'a', 'an', 'the', 'for', 'looking', 'seeking', 'urgently', 'urgent',
  'required', 'require', 'requires', 'wanted', 'needed', 'need', 'vacancy',
  'vacancies', 'opening', 'openings', 'position', 'positions', 'role', 'roles',
  'job', 'jobs', 'title', 'our', 'join', 'joining', 'as', 'now', 'immediate',
  'immediately', 'apply', 'new', 'open', 'and', 'or', 'also', 'with', 'of',
  'in', 'at', 'to', 'on', 'hot', 'alert', 'currently', 'multiple', 'several',
  'exciting', 'great', 'amazing', 'opportunity', 'opportunities'
]);

const REJECT = new Set([
  'experience', 'years', 'year', 'degree', 'candidate', 'candidates',
  'applicant', 'applicants', 'requirements', 'responsibilities', 'skills',
  'team', 'who', 'that', 'which', 'will', 'you', 'your', 'must', 'should',
  'can', 'may', 'work', 'works', 'working', 'mentoring', 'mentor'
]);

const bare = w =>
  w.toLowerCase().replace(/’/g, "'").replace(/^[^a-z']+|[^a-z']+$/g, '');

const TRAILING_JUNK =
  /\s+(?:needed|required|wanted|urgent(?:ly)?|immediate(?:ly)?|vacanc(?:y|ies)|opening|position|role|hiring|apply\s+now)$/i;

const EMPLOYMENT_ONLY =
  /^(?:full[\s-]?time|part[\s-]?time|contract(?:ual)?|permanent|temporary|freelance|remote|on[\s-]?site|hybrid|internship|paid|unpaid)\b/i;

const ACRONYMS = {
  ai: 'AI', ml: 'ML', llm: 'LLM', nlp: 'NLP', qa: 'QA', sqa: 'SQA', ui: 'UI',
  ux: 'UX', sre: 'SRE', api: 'API', apis: 'APIs', it: 'IT', hr: 'HR',
  php: 'PHP', sql: 'SQL', aws: 'AWS', gcp: 'GCP', erp: 'ERP', crm: 'CRM',
  devops: 'DevOps', ios: 'iOS', mern: 'MERN', mean: 'MEAN', rag: 'RAG',
  '.net': '.NET', 'asp.net': 'ASP.NET', 'c#': 'C#', 'c++': 'C++',
  'node.js': 'Node.js', nodejs: 'Node.js', node: 'Node.js',
  nestjs: 'NestJS', 'nest.js': 'NestJS', nextjs: 'Next.js', 'next.js': 'Next.js',
  reactjs: 'React.js', 'react.js': 'React.js', fastapi: 'FastAPI',
  javascript: 'JavaScript', typescript: 'TypeScript', n8n: 'n8n'
};

function titleCaseIfNeeded(s) {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (!letters || (letters !== letters.toUpperCase() && letters !== letters.toLowerCase())) {
    return s; // already mixed case: respect the author
  }
  return s
    .toLowerCase()
    .split(' ')
    .map(token =>
      token
        .split(/([-/])/)
        .map(part =>
          part === '-' || part === '/'
            ? part
            : ACRONYMS[part] || part.replace(/^(\p{L})/u, c => c.toUpperCase())
        )
        .join('')
    )
    .join(' ');
}

const singularizeRoleNouns = s =>
  s.replace(
    /\b(developer|engineer|programmer|architect|intern|internship|trainee|scientist|analyst|administrator|specialist|consultant|designer|tester|lead|manager|executive|officer|associate|coordinator|technician)s\b/gi,
    '$1'
  );

function finalizeTitle(s) {
  let t = s.replace(/\s+/g, ' ').trim().replace(/^[\s:–—|/&+-]+|[\s:–—|/&+-]+$/g, '');
  let prev;
  do {
    prev = t;
    t = t.replace(TRAILING_JUNK, '').trim();
  } while (t !== prev);
  return titleCaseIfNeeded(singularizeRoleNouns(t));
}

// All role phrases in a string, keeping only a contiguous "list"
// ("Backend Developer, Frontend Developer and QA Engineer").
function extractPhraseList(str) {
  const found = [];
  for (const m of String(str).matchAll(PHRASE_RE)) {
    let words = `${m[1]}${m[2]}`.trim().split(/\s+/);
    while (words.length > 1 && STOP.has(bare(words[0]))) words.shift();
    if (words.length > 6) words = words.slice(-6);
    if (words.some(w => REJECT.has(bare(w)))) continue;
    found.push({ t: words.join(' '), start: m.index, end: m.index + m[0].length });
  }
  if (!found.length) return [];
  const list = [found[0]];
  for (let i = 1; i < found.length; i++) {
    const gap = str.slice(found[i - 1].end, found[i].start);
    if (/^\s*(?:[,;/&]|\band\b|\bor\b)?\s*$/i.test(gap)) list.push(found[i]);
    else break;
  }
  return list.map(x => x.t);
}

// Value of a "Position: ..." style line -> [{title, context}]
function parseRoleValue(value, strong) {
  let v = String(value).replace(/#[\p{L}\p{N}_]+/gu, ' ');
  const context = [];
  v = v.replace(/[(\[{]([^)\]}]*)[)\]}]/g, (_, q) => { context.push(q); return ' '; });
  v = v.replace(/\s+/g, ' ').trim();
  v = v.split(/\s+[-–—|•@]\s+/)[0].trim();          // " – Lahore", " | Remote"
  v = v.replace(/\s+at\s+(?=[A-Z0-9]).*$/, '').trim(); // " at Acme"
  v = v.replace(/[.!]+$/, '');
  if (!v) return [];

  let titles = [];
  if (v.split(' ').length > 10) {
    titles = extractPhraseList(v);                   // it's a sentence
  } else {
    const parts = v.split(/\s*(?:[,;]|\s\/\s|\s&\s|\s+(?:and|or)\s+)\s*/i).filter(Boolean);
    const multi = parts.length > 1 && parts.every(p => NOUN_RE.test(p));
    for (const p of multi ? parts : [v]) {
      const words = p.split(' ');
      while (words.length > 1 && STOP.has(bare(words[0]))) words.shift();
      if (words.some(w => REJECT.has(bare(w)))) continue;
      const piece = words.join(' ');
      const hasNoun = NOUN_RE.test(piece);
      if (!hasNoun) {
        if (!strong) continue;
        if (EMPLOYMENT_ONLY.test(piece) || /^\d/.test(piece)) continue;
        if (/\b(?:positions?|vacanc\w*|seats?|openings?)\b/i.test(piece)) continue;
        if (piece.split(' ').length > 6) continue;
      }
      titles.push(piece);
    }
  }
  return titles
    .map(t => ({ title: finalizeTitle(t), context: context.join(' ') }))
    .filter(c => c.title.length >= 3);
}

// -------------------- Role --------------------

const STRONG_LABEL =
  '(?:job\\s+|open\\s+)?(?:position(?:\\s+title)?|role|job\\s*title|vacancy|designation|opening|hiring\\s+for)';
const WEAK_LABEL =
  "(?:title|post|hiring|looking\\s+for|required|wanted|we(?:'|’)re\\s+hiring|now\\s+hiring)";
const labelRe = label =>
  new RegExp(`(?:^|[|•]\\s*)${label}\\s*(?:[:：]|\\s[-–—]\\s)\\s*([^|•]+)`, 'i');
const STRONG_RE = labelRe(STRONG_LABEL);
const WEAK_RE = labelRe(WEAK_LABEL);

const HIRING_SENTENCES = [
  /\b(?:we(?:'|’)re|we\s+are|is|are|now|currently|urgently|immediately)\s+(?:hiring|recruiting|seeking|looking\s+for|in\s+need\s+of)\s+(.+)$/i,
  /\b(?:vacancy|vacancies|opening|openings|opportunity|opportunities)\s+(?:for|:)\s*(.+)$/i,
  /\b(?:hiring|recruiting|required|wanted|needed)\s*[:：]\s*(.+)$/i,
  /\bjoin\s+(?:us|our\s+team)\s+as\s+(.+)$/i,
  /\blooking\s+for\s+(.+)$/i,
  /\b(?:seeking|hiring)\s+(.+)$/i
];

const NON_TITLE_LINE =
  /^(?:location|company|apply|salary|deadline|email|e-mail|subject|job\s*type|experience|send|contact|how\s+to\s+apply|requirements?|responsibilit|skills?|about|benefits?|what|who|why|qualification|note|dm|share|follow|like|repost|you(?:'|’)ll)\b/i;

function searchRoles() {
  const uniq = list => {
    const seen = new Set();
    return list.filter(c => {
      const k = c.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 5);
  };

  // A. caller override
  if (typeof b.role === 'string' && b.role.trim()) {
    const c = uniq(parseRoleValue(b.role, true));
    if (c.length) return { candidates: c, source: 'provided', confidence: 'high' };
  }

  // B. labelled lines (Position:, Role:, Job Title:, ...)
  const strongHits = [];
  const weakHits = [];
  for (const line of lines.slice(0, 40)) {
    const s = stripLead(line);
    let m = s.match(STRONG_RE);
    if (m) strongHits.push(...parseRoleValue(m[1], true));
    m = s.match(WEAK_RE);
    if (m) weakHits.push(...parseRoleValue(m[1], false));
  }
  if (strongHits.length) {
    return { candidates: uniq(strongHits), source: 'labelled line', confidence: 'high' };
  }
  if (weakHits.length) {
    return { candidates: uniq(weakHits), source: 'labelled line (weak label)', confidence: 'medium' };
  }

  // C. "We are hiring X", "Looking for X", "Vacancy for X"
  const head = lines.filter(l => !isHashtagOnly(l) && !isBullet(l)).slice(0, 15);
  for (const line of head) {
    for (const re of HIRING_SENTENCES) {
      const m = stripLead(line).match(re);
      if (!m) continue;
      const found = extractPhraseList(m[1]).map(t => ({ title: finalizeTitle(t), context: '' }));
      if (found.length) {
        return { candidates: uniq(found), source: 'hiring sentence', confidence: 'medium' };
      }
      break;
    }
  }

  // D. role phrase in the first short lines
  const top = lines
    .filter(l => !isHashtagOnly(l) && !isBullet(l) && l.length < 120 && !NON_TITLE_LINE.test(stripLead(l)))
    .slice(0, 8);
  for (const line of top) {
    const found = extractPhraseList(line)
      .filter(t => t.split(/\s+/).length >= 2)
      .map(t => ({ title: finalizeTitle(t), context: '' }));
    if (found.length) {
      return { candidates: uniq(found), source: 'top-of-post phrase', confidence: 'low' };
    }
  }

  return { candidates: [], source: null, confidence: null };
}

const roleSearch = searchRoles();
const roleCandidateObjects = roleSearch.candidates;
const roleCandidates = roleCandidateObjects.map(c => c.title);
const primaryRole = roleCandidateObjects[0] || null;
const role = primaryRole ? primaryRole.title : null;
const roleContext = primaryRole ? primaryRole.context : '';

const isInternship = !!role && /\bintern(?:ship)?\b/i.test(role);

// -------------------- Company --------------------
// Only from explicit text. The email domain is returned as a HINT only.

function cleanCompany(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s*\((?:private|pvt\.?)\)\s*/ig, ' ')
    .replace(/\b(?:private|pvt\.?|limited|ltd\.?)\b\.?/ig, '')
    .replace(/\s+/g, ' ')
    .replace(/[|:—–!-]+$/, '')
    .trim();
}

const GENERIC_COMPANY =
  /^(?:we|we are|we're|we’re|our client|a company|the company|us|our team|team|hiring|a|an|the)$/i;

let company = typeof b.company === 'string' ? cleanCompany(b.company) : null;
let companySource = company ? 'provided' : null;

if (!company) {
  const companyPatterns = [
    [/^(?:company|organi[sz]ation|employer|hiring\s+company|client)\s*(?:name)?\s*[:：]\s*(.+)$/i, true],
    [/^(.{2,100}?)\s+(?:is|are)\s+(?:now\s+)?(?:hiring|seeking|looking\s+for|recruiting|expanding)\b/i, false],
    [/^(.{2,100}?)\s*[-–—|:]\s*(?:we(?:'|’)re\s+|we\s+are\s+|now\s+)?hiring\b/i, false]
  ];

  outer:
  for (const raw of lines.slice(0, 12)) {
    const line = stripLead(raw);
    for (const [pattern, labelled] of companyPatterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const candidate = cleanCompany(match[1]);
      if (!candidate || GENERIC_COMPANY.test(candidate)) continue;
      if (!labelled && (candidate.length > 60 || NOUN_RE.test(candidate))) continue;
      company = candidate;
      companySource = 'post text';
      break outer;
    }
  }
}
company = company || null;

const FREE_MAIL = /^(?:gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|proton|protonmail|gmx|aol|yandex|mail|zoho)$/i;
let companyHint = null;
if (!company && applicationEmail) {
  const domain = applicationEmail.split('@')[1] || '';
  const label = domain.split('.')[0];
  if (label && !FREE_MAIL.test(label)) {
    companyHint = label.charAt(0).toUpperCase() + label.slice(1);
  }
}

// -------------------- Experience --------------------

const experienceLine = lines.find(line =>
  /experience|\bexp\b/i.test(line) && /\d/.test(line)
) || null;

const experienceMatch = experienceLine?.match(
  /(\d+(?:\.\d+)?)\s*(?:(\+)|(?:[-–]|\bto\b)\s*(\d+(?:\.\d+)?))?\s*(years?|yrs?|months?)/i
);

const experience = experienceMatch
  ? {
      minimum: Number(experienceMatch[1]),
      maximum: experienceMatch[3] ? Number(experienceMatch[3]) : null,
      unit: /month/i.test(experienceMatch[4]) ? 'months' : 'years',
      minimumOnly: !!experienceMatch[2],
      source: experienceLine
    }
  : null;

const entryLevel =
  /fresh(?:er|ers|\s+graduates?)|entry[\s-]level|no\s+experience\s+(?:required|needed)|graduates?\s+(?:are\s+)?welcome/i
    .test(normalizedText);

// -------------------- Location and work mode --------------------

const CITIES = [
  'islamabad', 'rawalpindi', 'lahore', 'karachi', 'multan', 'peshawar',
  'faisalabad', 'quetta', 'sialkot',
  // added in 0.4.0
  'gujranwala', 'hyderabad', 'abbottabad', 'bahawalpur', 'sargodha', 'gujrat',
  'sahiwal', 'mardan', 'jhelum', 'dubai', 'riyadh', 'jeddah', 'doha',
  'london', 'toronto', 'berlin'
];

const cleanLocation = s =>
  s
    .replace(/\s*\((?:on[ -]?site|remote|hybrid)\)/ig, '')
    .replace(/[\s.,;|-]+$/, '')
    .trim();

let location = null;
let locationSource = null;

for (const raw of lines) {
  const s = stripLead(raw);
  let m = raw.match(/\b(?:job\s+|work\s+)?location\s*[:：]\s*([^|•]+)/i);
  if (!m) m = s.match(/^(?:city|office(?:\s+location)?|based\s+in)\s*[:：]\s*([^|•]+)/i);
  if (!m) m = raw.match(/^📍\s*([^|•]+)/u);
  if (m) {
    const candidate = cleanLocation(m[1]);
    if (candidate) {
      location = candidate;
      locationSource = 'labelled line';
      break;
    }
  }
}

if (!location) {
  const mentioned = CITIES.filter(city =>
    new RegExp('\\b' + city + '\\b', 'i').test(normalizedText)
  );
  if (mentioned.length === 1) {
    location = mentioned[0].charAt(0).toUpperCase() + mentioned[0].slice(1);
    locationSource = 'city mention';
  }
}

const MODE_RE = /\bon[ -]?site\b|\bin[ -]office\b|\bremote\b|\bwork from home\b|\bwfh\b|\bhybrid\b/ig;
const toMode = raw =>
  /hybrid/i.test(raw) ? 'hybrid' : /remote|home|wfh/i.test(raw) ? 'remote' : 'on-site';
const modesIn = str => [...new Set((str.match(MODE_RE) || []).map(toMode))];

const modeLabelLines = lines.filter(l =>
  /\b(?:work\s*(?:mode|type|setup|arrangement)|job\s*type|mode|setup|arrangement|location)\s*[:：]/i.test(l)
);
let modes = modesIn(modeLabelLines.join('\n'));
if (modes.length !== 1) modes = modesIn(normalizedText);
const workArrangement = modes.length === 1 ? modes[0] : null;

// -------------------- Skills --------------------

const skillPatterns = {
  'Node.js': /\bnode(?:\.js|js)?\b/i,
  'NestJS': /\bnest(?:\.js|js)\b/i,
  'React': /\breact(?![\s-]*native)(?:\.?js)?\b/i,
  'Angular': /\bangular\b/i,
  'Next.js': /\bnext(?:\.js|js)\b/i,
  'JavaScript': /\bjavascript\b/i,
  'TypeScript': /\btypescript\b/i,
  'PostgreSQL': /\bpostgres(?:ql)?\b/i,
  'MongoDB': /\bmongo(?:db)?\b/i,
  'Python': /\bpython\b/i,
  'FastAPI': /\bfastapi\b/i,
  'Flutter': /\bflutter\b/i,
  'Dart': /\bdart\b/i,
  'React Native': /\breact[\s-]*native\b/i,
  'Docker': /\bdocker\b/i,
  'Kubernetes': /\bkubernetes\b|\bk8s\b/i,
  'Django': /\bdjango\b/i,
  'ASP.NET Core': /\basp\.net(?:\s+core)?\b|(?<![\p{L}\p{N}])\.net\b/iu,
  'C#': /\bc#/i,
  'Linux': /\blinux\b/i,
  'GitHub Actions': /\bgithub actions\b/i,
  'Azure': /\bazure\b/i,
  'AWS': /\baws\b/i,
  'Redis': /\bredis\b/i,
  'RAG': /\brag\b/i,
  'LLMs': /\bllms?\b/i,
  'n8n': /\bn8n\b/i,
  'REST APIs': /\brest(?:ful)?\s*apis?\b/i
};

const skills = Object.entries(skillPatterns)
  .filter(([, pattern]) => pattern.test(normalizedText))
  .map(([name]) => name);

// -------------------- Resume catalogue --------------------
// One entry per PDF in your resumes folder.

const mkResume = (id, fileName, skillList, summary) => ({
  id,
  category: id,
  fileName,
  path: `${CONFIG.resumeDir}/${fileName}`,
  skills: skillList,
  summary
});

const resumeCatalog = [
  mkResume('fullstack', 'Muneeb_Resume_FullStack.pdf',
    ['Node.js', 'NestJS', 'React', 'Next.js', 'TypeScript', 'Python', 'FastAPI', 'PostgreSQL', 'Docker', 'REST APIs'],
    'My work includes a multi-tenant Document Intelligence platform using Next.js, FastAPI and Azure, and Stratos, built with NestJS, Next.js and PostgreSQL.'),
  mkResume('ai', 'Muneeb_Resume_AI_Engineer.pdf',
    ['Python', 'TypeScript', 'FastAPI', 'Node.js', 'NestJS', 'React', 'Next.js', 'Docker', 'PostgreSQL', 'REST APIs', 'RAG', 'n8n'],
    'My projects include a voice-enabled RAG assistant, a function-calling voice receptionist, and AI vision and document-processing services.'),
  mkResume('devops', 'Muneeb_Resume_DevOps.pdf',
    ['Linux', 'Docker', 'GitHub Actions', 'Azure', 'Python', 'FastAPI', 'PostgreSQL', 'Redis', 'Django'],
    'My work includes multi-stage Docker builds, Docker Compose health checks, GitHub Actions workflows, and deployments integrating Azure services.'),
  mkResume('python', 'Muneeb_Resume_Django.pdf',
    ['Python', 'Django', 'FastAPI', 'PostgreSQL', 'Redis', 'Docker', 'REST APIs', 'React', 'Next.js', 'Node.js', 'NestJS'],
    'My projects include Django and FastAPI microservices, a Django LLM chatbot, and a real-time chat application using Django Channels and Redis.'),
  mkResume('mobile', 'Muneeb_Resume_Flutter_Mobile.pdf',
    ['Flutter', 'React Native', 'Dart', 'Node.js', 'NestJS', 'FastAPI', 'React', 'Next.js', 'PostgreSQL', 'Docker', 'REST APIs'],
    'My work includes a React Native competitive gaming platform and Flutter applications using Riverpod and BLoC, backed by REST APIs.'),
  mkResume('dotnet', 'Muneeb_Ur_Rehman_ASP.NET.pdf',
    ['ASP.NET Core', 'C#', 'Node.js', 'NestJS', 'React', 'Next.js', 'FastAPI', 'PostgreSQL', 'Docker', 'REST APIs'],
    'My ClassMate AI project uses ASP.NET Core and Next.js with PostgreSQL, Google OAuth and an AI study-guide generation pipeline.')
];

const CATEGORY_ORDER = resumeCatalog.map(r => r.category);

// -------------------- Resume scoring --------------------
// score = best TITLE signal (0-10) + BODY signals (sum, capped at 8)

const sig = (k, re, w) => ({ k, re, w });

const TITLE_SIGNALS = {
  fullstack: [
    sig('full-stack/MERN', /full[\s-]?stack|\bmern\b|\bmean\s+stack\b|\bmevn\b|polyglot/i, 10),
    sig('JS framework', /\bnode(?:\.?js)?\b|\bnest(?:\.?js)?\b|\bnext(?:\.?js)?\b|\breact(?![\s-]*native)(?:\.?js)?\b|\bexpress\.?js\b|\bangular\b|\bvue(?:\.?js)?\b|\bjavascript\b|\btypescript\b/i, 7),
    sig('generic dev', /\b(?:developer|programmer|software|application|coder|web|back[\s-]?end|front[\s-]?end)\b/i, 4)
  ],
  ai: [
    sig('AI/ML', /\bai\b|artificial intelligence|machine[\s-]?learning|\bml\b|\bllms?\b|\bnlp\b|gen(?:erative)?[\s-]?ai|deep learning|computer vision|data scien|prompt engineer|\brag\b|chatbot|\bn8n\b|\bagentic\b|\bai[\s-]*agents?\b|(?:workflow|process|rpa)\s+automation|\bmlops\b/i, 10)
  ],
  python: [
    sig('Python stack', /\bpython\b|\bdjango\b|\bfastapi\b|\bflask\b|\bdrf\b/i, 10),
    sig('data engineer', /\bdata\s+engineer/i, 5)
  ],
  mobile: [
    sig('mobile', /\bflutter\b|\bdart\b|react[\s-]*native|\bandroid\b|\bios\b|\bkotlin\b|\bswift(?:ui)?\b|\bmobile\b|\bapp\s+developer\b/i, 10)
  ],
  dotnet: [
    sig('.NET', /asp\.?\s?net|(?<![\p{L}\p{N}])\.net\b|\bdot\s?net\b|\bdotnet\b|\bc#|\bc[\s-]sharp\b|\bblazor\b|\bentity framework\b/iu, 10)
  ],
  devops: [
    sig('DevOps/SRE/cloud', /dev[\s-]?ops|\bsre\b|site reliability|\bsysadmin\b|system administrator|infrastructure|platform engineer|cloud\s+(?:engineer|architect|developer|support)|release engineer|\bkubernetes\b|\bdevsecops\b/i, 10),
    sig('MLOps', /\bmlops\b/i, 8)
  ]
};

const BODY_SIGNALS = {
  fullstack: [
    sig('full-stack', /full[\s-]?stack|\bmern\b|\bmean\s+stack\b/i, 2),
    sig('Node', /\bnode(?:\.?js)?\b/i, 2),
    sig('NestJS', /\bnest\.?js\b/i, 2),
    sig('React', /\breact(?![\s-]*native)(?:\.?js)?\b/i, 2),
    sig('Next.js', /\bnext\.?js\b/i, 2),
    sig('Express', /\bexpress\.?js\b/i, 1),
    sig('TypeScript', /\btypescript\b/i, 1),
    sig('JavaScript', /\bjavascript\b/i, 1),
    sig('Angular/Vue', /\bangular\b|\bvue(?:\.?js)?\b/i, 1)
  ],
  ai: [
    sig('LLM', /\bllms?\b/i, 3),
    sig('RAG', /\brag\b/i, 3),
    sig('OpenAI/GPT', /\bopenai\b|\bgpt[-\s]?\d|\bchatgpt\b/i, 2),
    sig('Anthropic', /\banthropic\b/i, 1),
    sig('LangChain', /langchain|llama[\s-]?index/i, 3),
    sig('vector DB', /vector\s*(?:db|database|store)s?|pinecone|pgvector|chroma(?:db)?|faiss|weaviate|qdrant|milvus/i, 2),
    sig('GenAI', /generative ai|gen[\s-]?ai|\bgenai\b/i, 3),
    sig('ML', /machine[\s-]?learning|\bml\b/i, 3),
    sig('deep learning', /deep learning|pytorch|tensorflow|keras/i, 2),
    sig('NLP', /\bnlp\b|natural language/i, 2),
    sig('vision/OCR', /computer vision|opencv|\bocr\b/i, 2),
    sig('n8n', /\bn8n\b/i, 2),
    sig('AI agents', /\bai[\s-]*agents?\b|\bagentic\b|\bllm[\s-]*agents?\b/i, 2),
    sig('embeddings', /embeddings?/i, 2),
    sig('prompting', /prompt engineering/i, 2),
    sig('AI', /\bai\b/i, 1)
  ],
  python: [
    sig('Python', /\bpython\b/i, 1),
    sig('Django', /\bdjango\b/i, 3),
    sig('FastAPI', /\bfastapi\b/i, 3),
    sig('Flask', /\bflask\b/i, 3),
    sig('DRF', /django rest|\bdrf\b/i, 2),
    sig('Celery', /\bcelery\b/i, 1)
  ],
  mobile: [
    sig('Flutter', /\bflutter\b/i, 3),
    sig('Dart', /\bdart\b/i, 2),
    sig('React Native', /react[\s-]*native/i, 3),
    sig('Android', /\bandroid\b/i, 2),
    sig('iOS', /\bios\b/i, 2),
    sig('Kotlin', /\bkotlin\b/i, 2),
    sig('Swift', /\bswift(?:ui)?\b/i, 2),
    sig('mobile app', /mobile\s+(?:app|application|development)s?/i, 2),
    sig('Riverpod/BLoC', /\briverpod\b|\bbloc\b/i, 1)
  ],
  dotnet: [
    sig('ASP.NET', /asp\.?\s?net/i, 3),
    sig('C#', /\bc#/i, 3),
    sig('.NET', /(?<![\p{L}\p{N}])\.net\b|\bdotnet\b/iu, 3),
    sig('EF', /entity framework/i, 2),
    sig('Blazor', /\bblazor\b/i, 2),
    sig('LINQ', /\blinq\b/i, 1),
    sig('SQL Server', /sql server/i, 1)
  ],
  devops: [
    sig('Kubernetes', /\bkubernetes\b|\bk8s\b/i, 3),
    sig('Terraform', /\bterraform\b/i, 3),
    sig('Ansible', /\bansible\b/i, 3),
    sig('Helm', /\bhelm\b/i, 2),
    sig('CI/CD', /ci\s*\/\s*cd|\bcicd\b|continuous (?:integration|delivery|deployment)/i, 2),
    sig('Jenkins', /\bjenkins\b/i, 2),
    sig('GH Actions/GitLab CI', /github actions|gitlab[\s-]?ci|circleci/i, 2),
    sig('monitoring', /prometheus|grafana|datadog/i, 2),
    sig('cloud', /\baws\b|\bgcp\b|\bazure\b|google cloud/i, 1),
    sig('Linux', /\blinux\b/i, 1),
    sig('IaC', /infrastructure as code|\biac\b/i, 3),
    sig('Nginx', /\bnginx\b/i, 1)
  ]
};

// Roles none of your resumes fit. We refuse to guess a resume for these.
const UNSUPPORTED_RE =
  /\bjava\b|\bphp\b|\blaravel\b|\bwordpress\b|\bgolang\b|\bgo\s+(?:developer|engineer|lang)\b|\bruby\b|\brails\b|\brust\b|\bscala\b|c\+\+|\bembedded\b|\bsap\b|\bsalesforce\b|\bqa\b|\bsqa\b|quality assurance|\btester\b|\bsdet\b|\bui[\s/]*ux\b|\bgraphic\b|\bseo\b|\bmarketing\b|\bsales\b|\baccount(?:ant|s)?\b|\bhr\b|\brecruit/i;

const neutralizeAiModifiers = s =>
  s.replace(/\bai[\s-]*(?:first|powered|driven|enabled|native|assisted|augmented|based)\b/gi, ' ');

function pickResume(titleText) {
  // Caller override wins.
  if (typeof b.resumeCategory === 'string') {
    const forced = resumeCatalog.find(r => r.category === b.resumeCategory.trim().toLowerCase());
    if (forced) {
      return {
        category: forced.category,
        resume: forced,
        confidence: 'provided',
        reason: 'Resume category provided by caller',
        scores: {},
        runnerUp: null,
        notes: []
      };
    }
  }

  const title = neutralizeAiModifiers(titleText || '');
  const scores = {};
  const detail = {};
  let bestTitleScore = 0;

  for (const cat of CATEGORY_ORDER) {
    let t = 0;
    let tHit = null;
    for (const s of TITLE_SIGNALS[cat]) {
      if (s.re.test(title) && s.w > t) { t = s.w; tHit = s.k; }
    }
    let bodySum = 0;
    const bodyHits = [];
    for (const s of BODY_SIGNALS[cat]) {
      if (s.re.test(normalizedText)) { bodySum += s.w; bodyHits.push(s.k); }
    }
    bodySum = Math.min(bodySum, 8);
    scores[cat] = t + bodySum;
    detail[cat] = { tHit, t, bodyHits };
    bestTitleScore = Math.max(bestTitleScore, t);
  }

  const ranked = [...CATEGORY_ORDER].sort(
    (a, z) => scores[z] - scores[a] || CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(z)
  );
  const top = ranked[0];
  const second = ranked[1];
  const margin = scores[top] - scores[second];
  const notes = [];

  const unsupported = title.match(UNSUPPORTED_RE);
  if (unsupported && bestTitleScore < 10) {
    return {
      category: null,
      resume: null,
      confidence: null,
      reason: `Role looks outside your resumes ("${unsupported[0]}"); choose manually.`,
      scores,
      runnerUp: null,
      notes
    };
  }
  if (unsupported) notes.push(`Title also mentions "${unsupported[0]}", which none of your resumes cover.`);

  if (scores[top] < 4) {
    return {
      category: null,
      resume: null,
      confidence: null,
      reason: 'No clear tech signals in the role or post; choose manually.',
      scores,
      runnerUp: null,
      notes
    };
  }

  const confidence =
    scores[top] >= 10 && margin >= 6 ? 'high' : margin >= 3 ? 'medium' : 'low';

  if (margin < 2) {
    notes.push(`Close call: ${top} (${scores[top]}) vs ${second} (${scores[second]}).`);
  }

  const d = detail[top];
  const reason = [
    d.t ? `title: ${d.tHit} (${d.t})` : 'title: no specific signal',
    d.bodyHits.length ? `post: ${d.bodyHits.slice(0, 6).join(', ')}` : null
  ].filter(Boolean).join('; ');

  return {
    category: top,
    resume: resumeCatalog.find(r => r.category === top),
    confidence,
    reason,
    scores,
    runnerUp: scores[second] > 0 ? { category: second, score: scores[second] } : null,
    notes
  };
}

// -------------------- Application identity (app-v1) --------------------
// Same key format and normalisation as the tracker backfill.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function toIsoDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? date.toISOString().slice(0, 10)
    : null;
}

function parseDate(str) {
  let m;
  if ((m = str.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/))) {
    const r = toIsoDate(m[1], m[2], m[3]); if (r) return r;
  }
  if ((m = str.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/))) {   // DD/MM/YYYY
    const r = toIsoDate(m[3], m[2], m[1]); if (r) return r;
  }
  if ((m = str.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]+)[,\s]+(20\d{2})\b/))) {
    const r = toIsoDate(m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], m[1]); if (r) return r;
  }
  if ((m = str.match(/\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/))) {
    const r = toIsoDate(m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], m[2]); if (r) return r;
  }
  return null;
}

const DEADLINE_LABEL =
  /deadline|closing date|last date|apply (?:by|before|till|until)|closes? (?:on|by)|applications? close|due date|submit (?:by|before)/i;

function makeApplicationIdentity({ role, location, emails = [], company, deadlineText = '', formLinks = [] }) {
  const normalize = value =>
    String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/full[\s-]*stack/g, 'full stack')
      .replace(/back[\s-]*end/g, 'backend')
      .replace(/front[\s-]*end/g, 'frontend')
      .replace(/\bjr\.?\b/g, 'junior')
      .replace(/\bsr\.?\b/g, 'senior')
      .replace(/\bengineers\b/g, 'engineer')
      .replace(/\bdevelopers\b/g, 'developer')
      .replace(/\binterns\b/g, 'intern')
      .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
      .trim();

  const roleKey = normalize(role).replace(/^ai first /, '');
  const normalizedLocation = normalize(location);

  const matchingCities = CITIES.filter(city =>
    new RegExp('\\b' + city + '\\b').test(normalizedLocation)
  );

  const locationKey = matchingCities.length
    ? matchingCities.sort().join('+')
    : /\bremote\b/.test(normalizedLocation)
      ? 'remote'
      : normalizedLocation || 'unknown';

  const companyKey = normalize(company)
    .replace(/\b(private|pvt|limited|ltd)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const addresses = [...new Set(emails.map(e => String(e).trim().toLowerCase()))];

  // Deadline: the labelled line, or the next line if the label ends the line.
  const dlLines = String(deadlineText).normalize('NFKC').split('\n');
  const dlIndex = dlLines.findIndex(l => DEADLINE_LABEL.test(l));
  let deadline = null;
  if (dlIndex !== -1) {
    deadline = parseDate(dlLines[dlIndex]);
    if (!deadline && /[:：-]\s*$/.test(dlLines[dlIndex].trim()) && dlLines[dlIndex + 1]) {
      deadline = parseDate(dlLines[dlIndex + 1]);
    }
  }

  const warnings = [];
  let method;
  let destination;

  const useForm = () => {
    method = 'form';
    destination = String(formLinks[0]).trim().split('#')[0];
    const parts = destination.split('?');
    const query = (parts[1] || '')
      .split('&')
      .filter(p => p && !/^(utm_[^=]*|trk|trackingid|fbclid|gclid)=/i.test(p))
      .sort();
    destination = parts[0].replace(/\/$/, '') + (query.length ? '?' + query.join('&') : '');
  };

  if (addresses.length === 1) {
    method = 'email';
    destination = addresses[0];
  } else if (formLinks.length === 1) {
    useForm();
    if (addresses.length > 1) warnings.push('Multiple emails and no clear recipient; ID uses the application form.');
  } else if (addresses.length > 1) {
    warnings.push('Multiple emails: choose the application recipient before generating an ID.');
  } else if (formLinks.length > 1) {
    warnings.push('Multiple forms: choose the application form.');
  } else if (companyKey) {
    method = 'company';
    destination = companyKey;
    warnings.push('Company fallback: cannot exactly match an email/form ID until the destination is backfilled.');
  }

  if (!roleKey) warnings.push('Role missing.');
  if (locationKey === 'unknown') warnings.push('Location missing: cannot distinguish offices.');
  if (!deadline) {
    warnings.push(
      dlIndex !== -1
        ? 'Deadline mentioned but not parsed (missing year or unknown format).'
        : 'Deadline missing: repeated hiring cycles require manual review.'
    );
  }

  const baseKey = destination && roleKey
    ? ['app-v1', method, destination, roleKey, locationKey].map(encodeURIComponent).join('|')
    : null;

  return {
    applicationId: baseKey ? baseKey + '|' + (deadline || 'no-deadline') : null,
    applicationBaseKey: baseKey,
    applicationDeadline: deadline,
    applicationIdMethod: method || null,
    applicationIdWarnings: warnings
  };
}

const identityFor = roleTitle =>
  makeApplicationIdentity({
    role: roleTitle,
    location: location || workArrangement,
    emails: applicationEmail ? [applicationEmail] : emails,
    company,
    deadlineText: normalizedText,
    formLinks: formCandidates
  });

// -------------------- Resume + identity for the primary role --------------------

const resumePick = role ? pickResume(`${role} ${roleContext}`) : {
  category: null, resume: null, confidence: null, reason: 'No role detected.', scores: {}, runnerUp: null, notes: []
};

const resumeCategory = resumePick.category;
const resumeMatchReason = resumePick.reason;
const selectedResume = resumePick.resume
  ? { ...resumePick.resume, confidence: resumePick.confidence }
  : null;

const identity = identityFor(role);

// Multi-role posts: one option per role, each with its own resume + ID.
const roleOptions = roleCandidateObjects.length > 1
  ? roleCandidateObjects.map(c => {
      const pick = pickResume(`${c.title} ${c.context}`);
      const id = identityFor(c.title);
      return {
        role: c.title,
        resumeCategory: pick.category,
        resumeFile: pick.resume ? pick.resume.fileName : null,
        resumeConfidence: pick.confidence,
        applicationId: id.applicationId
      };
    })
  : null;

// -------------------- Email draft --------------------

const overlappingSkills = skills
  .filter(skill => (selectedResume?.skills || []).includes(skill))
  .slice(0, 6);

const formatList = items =>
  items.length <= 2
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;

function findSubject(roleTitle) {
  for (const line of lines) {
    const m = line.match(/\bsubject(?:\s*line)?\s*[:：]\s*["“']?(.+?)["”']?\s*$/i);
    if (!m) continue;
    let s = m[1].replace(/\s*[|•].*$/, '');
    s = s
      .replace(/[(\[<{]\s*(?:your|ur)\s+(?:full\s+)?name\s*[)\]>}]|\b(?:your|ur)\s+(?:full\s+)?name\b/gi, profile.name)
      .replace(/[(\[<{]\s*(?:job\s+)?(?:position|role|job\s*title|post)\s*[)\]>}]/gi, roleTitle)
      .replace(/\s+/g, ' ')
      .trim();
    if (/[\[<{][^\]>}]*[\]>}]/.test(s) || /\byour\b/i.test(s)) continue; // unresolved placeholder
    if (s.length >= 5 && s.length <= 150) return s;
  }
  return null;
}

function buildEmailBody() {
  const skillsLine = overlappingSkills.length
    ? `My experience with ${formatList(overlappingSkills)} aligns closely with the requirements of this role.`
    : '';
  const summaryLine = selectedResume?.summary?.trim() || '';
  const attachmentLine = selectedResume?.fileName ? 'I have attached my resume for your review.' : '';

  const signature = [
    profile.name,
    profile.email,
    `GitHub: ${profile.github}`,
    `LinkedIn: ${profile.linkedin}`
  ].filter(Boolean).join('\n');

  const where = company ? `at ${company}` : 'at your organization';

  return [
    'Dear Hiring Team,',
    `I am writing to express my interest in the ${role} position ${where}.`,
    [skillsLine, summaryLine].filter(Boolean).join(' '),
    [
      attachmentLine,
      'I would welcome the opportunity to discuss how my background and skills can contribute to your team.'
    ].filter(Boolean).join(' '),
    'Thank you for your time and consideration. I look forward to hearing from you.',
    `Kind regards,\n${signature}`
  ].filter(Boolean).join('\n\n');
}

const postSubject = role ? findSubject(role) : null;

const emailDraft = role && applicationEmail
  ? {
      to: applicationEmail,
      subject: postSubject || `Application for ${role} – ${profile.name}`,
      subjectSource: postSubject ? 'post' : 'default',
      body: buildEmailBody(),
      attachment: selectedResume?.fileName || null,
      attachmentPath: selectedResume?.path || null,
      attachmentLoaded: false,
      status: 'review_required'
    }
  : null;

const route =
  emails.length && formCandidates.length
    ? 'email_and_form'
    : emails.length
      ? 'email'
      : formCandidates.length
        ? 'form'
        : 'needs_review';

// -------------------- Review reasons --------------------

const reviewReasons = [];

if (!role) {
  reviewReasons.push('No role title detected; set "role" in the request or fix manually.');
} else {
  if (roleCandidates.length > 1) {
    reviewReasons.push(
      `Multiple roles detected (${roleCandidates.join('; ')}); first one used. See roleOptions.`
    );
  }
  if (roleSearch.confidence === 'low') {
    reviewReasons.push(`Role guessed from ${roleSearch.source}; verify "${role}".`);
  }
}

if (emails.length > 1 && !applicationEmail) {
  reviewReasons.push('Several emails found; choose the application recipient.');
} else if (!emails.length && !formCandidates.length) {
  reviewReasons.push('No application email or form found.');
} else if (emails.length > 1 && applicationEmail) {
  reviewReasons.push(`Several emails found; used ${applicationEmail} (${applicationEmailReason}). Verify.`);
}

if (formCandidates.length && emails.length) {
  reviewReasons.push('Both email and form are present; choose the application method.');
}

if (!selectedResume) {
  reviewReasons.push(`No resume selected: ${resumeMatchReason}`);
} else {
  if (selectedResume && resumePick.confidence !== 'high' && resumePick.confidence !== 'provided') {
    reviewReasons.push(`Resume match is ${resumePick.confidence} confidence (${resumeMatchReason}).`);
  }
  reviewReasons.push(
    'Resume selected from catalogue; file existence and attachment loading have not been verified.'
  );
}
reviewReasons.push(...resumePick.notes);

if (experience) {
  reviewReasons.push('Check your experience against the requirement; no eligibility decision has been made.');
}

if (!company) {
  reviewReasons.push(
    companyHint
      ? `Company not stated in the post; email domain suggests "${companyHint}" (hint only, not used).`
      : 'Company could not be extracted; confirm it manually.'
  );
}

if (locationSource === 'city mention') {
  reviewReasons.push(`Location inferred from a single city mention (${location}); verify.`);
}

reviewReasons.push(...identity.applicationIdWarnings);

// -------------------- Output --------------------

const ok = !!identity.applicationId && !!role;

if (!ok && CONFIG.throwWhenNoApplicationId) {
  throw new Error(
    'Cannot generate Application ID: confirm one role and one application destination.'
  );
}

return [
  {
    json: {
      ok,
      status: ok ? 'review_required' : 'needs_manual_review',
      parserVersion: '0.4.0',

      ...identity,

      company,
      companySource,
      companyHint,

      roleCandidate: role,
      roleCandidates,
      roleSource: roleSearch.source,
      roleConfidence: roleSearch.confidence,
      roleOptions,
      isInternship,
      experience,
      entryLevel,
      location,
      locationSource,
      workArrangement,
      skills,

      resumeCategory,
      resumeMatchReason,
      resumeConfidence: resumePick.confidence,
      resumeScores: resumePick.scores,
      resumeRunnerUp: resumePick.runnerUp,
      selectedResume,

      emailDraft,
      reviewReasons,

      emails,
      applicationEmail,
      applicationEmailReason,
      formCandidates,
      otherLinks: links.filter(link => !formCandidates.includes(link)),
      route,

      postUrl: typeof b.url === 'string' ? b.url : null,

      text,
      normalizedText,
      capturedAt: b.capturedAt || null,
      receivedAt: new Date().toISOString(),

      note:
        'Rule-based extraction and draft only. No application sent. Resume metadata selected; PDF not loaded as an attachment.'
    }
  }
];
