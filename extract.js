const b = $json.body || {};

if (
  typeof b.text !== 'string' ||
  !b.text.trim() ||
  b.text.length > 50000
) {
  throw new Error('Provide post text (1–50,000 characters).');
}

const text = b.text.trim();

const emails = [
  ...new Set(
    (
      text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
    ).map(email => email.toLowerCase())
  )
];

const rawLinks = [
  ...(Array.isArray(b.links)
    ? b.links.filter(link => typeof link === 'string')
    : []),
  ...(text.match(/https?:\/\/[^\s<>"']+/gi) || [])
];

const links = [
  ...new Set(
    rawLinks.map(link => link.replace(/[),.;]+$/, ''))
  )
].filter(link => /^https?:\/\//i.test(link));

for (const link of Array.isArray(b.links) ? b.links : []) {
  if (typeof link === 'string' && /^mailto:/i.test(link)) {
    const address = link.slice(7).split('?')[0];

    if (
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) &&
      !emails.includes(address.toLowerCase())
    ) {
      emails.push(address.toLowerCase());
    }
  }
}

const formCandidates = links.filter(link =>
  /forms\.gle|docs\.google\.com\/forms|typeform\.com|greenhouse\.io|lever\.co|ashbyhq\.com|workday|jotform|\/apply\b|\/application\b/i.test(link)
);

// Normalize stylized Unicode headings.
const normalizedText = text.normalize('NFKC');

const lines = normalizedText
  .split(/\n/)
  .map(line => line.trim())
  .filter(Boolean);

const rolePattern = /(?<!\w)(?:(?:senior|junior|jr\.?|sr\.?|associate|lead|mid[ -]level|staff|principal)\s+)?(?:(?:full[ -]?stack|back[ -]?end|front[ -]?end|software|web|mobile|android|ios|flutter|react(?:\s+native)?|node(?:\.js)?|mern(?:\s+stack)?|python|django|fastapi|ASP\.NET(?:\s+Core)?|\.?NET|C#|AI|machine learning|devops|data|QA|SQA|polyglot)(?:\s*(?:\/|\+|&|and)\s*(?:react|angular|node(?:\.js)?|nest(?:js)?))?\s+)+(?:developers?|engineers?|interns?)\b/ig;

// Prefer hiring/title lines over responsibility bullets.
const headings = lines.filter(line =>
  /hiring|position\s*:|role\s*:|job title\s*:|vacanc/i.test(line)
);

const titleLines = [
  ...headings,
  ...lines.slice(0, 5).filter(line =>
    !/^[-•]/.test(line) && line.length < 160
  )
];

const roleCandidates = [
  ...new Set(
    titleLines.flatMap(line =>
      [...line.matchAll(rolePattern)].map(match => match[0])
    )
  )
];

const role = roleCandidates.length === 1
  ? roleCandidates[0]
  : null;

// Experience.
const experienceLine = lines.find(line =>
  /experience/i.test(line) && /\d/.test(line)
) || null;

const experienceMatch = experienceLine?.match(
  /(\d+(?:\.\d+)?)\s*(?:(\+)|[-–]\s*(\d+(?:\.\d+)?))?\s*(years?|yrs?|months?)/i
);

const experience = experienceMatch
  ? {
      minimum: Number(experienceMatch[1]),
      maximum: experienceMatch[3]
        ? Number(experienceMatch[3])
        : null,
      unit: /month/i.test(experienceMatch[4])
        ? 'months'
        : 'years',
      minimumOnly: !!experienceMatch[2],
      source: experienceLine
    }
  : null;

// Location and work arrangement.
const locationLine = lines.find(line =>
  /\blocation\s*:/i.test(line)
);

const location = locationLine
  ? locationLine
      .split(/location\s*:/i)[1]
      .replace(/\s*\((?:on[ -]?site|remote|hybrid)\)/ig, '')
      .trim()
  : null;

const modes = [
  ...new Set(
    (
      normalizedText.match(
        /\bon[ -]?site\b|\bremote\b|\bhybrid\b/ig
      ) || []
    ).map(mode =>
      /on/i.test(mode) ? 'on-site' : mode.toLowerCase()
    )
  )
];

const workArrangement = modes.length === 1
  ? modes[0]
  : null;

// Skills mentioned in the job post.
const skillPatterns = {
  'Node.js': /\bnode(?:\.js|js)?\b/i,
  'NestJS': /\bnest(?:\.js|js)\b/i,
  'React': /\breact\b/i,
  'Angular': /\bangular\b/i,
  'Next.js': /\bnext(?:\.js|js)\b/i,
  'TypeScript': /\btypescript\b/i,
  'PostgreSQL': /\bpostgres(?:ql)?\b/i,
  'Python': /\bpython\b/i,
  'FastAPI': /\bfastapi\b/i,
  'Flutter': /\bflutter\b/i,
  'React Native': /\breact native\b/i,
  'Docker': /\bdocker\b/i,
  'Django': /\bdjango\b/i,
  'ASP.NET Core': /\basp\.net(?:\s+core)?\b|(?:^|\W)\.net\b/i,
  'C#': /\bc#/i,
  'Linux': /\blinux\b/i,
  'GitHub Actions': /\bgithub actions\b/i,
  'Azure': /\bazure\b/i,
  'Redis': /\bredis\b/i,
  'RAG': /\brag\b/i,
  'n8n': /\bn8n\b/i,
  'REST APIs': /\brest(?:ful)?\s*apis?\b/i
};

const skills = Object.entries(skillPatterns)
  .filter(([, pattern]) => pattern.test(normalizedText))
  .map(([name]) => name);

// Select a resume category.
let resumeCategory = null;
let resumeMatchReason = null;

if (role) {
  const specializations = [
    [/devops/i, 'devops'],
    [/asp\.net|\.net|c#/i, 'dotnet'],
    [/django|fastapi|python/i, 'python'],
    [/mobile|flutter|android|ios|react native/i, 'mobile'],
    [/\bAI\b|machine learning/i, 'ai']
  ].filter(([pattern]) => pattern.test(role));

  if (specializations.length === 1) {
    resumeCategory = specializations[0][1];
    resumeMatchReason = 'Specialization in role title';
  } else if (
    specializations.length === 0 &&
    /full[ -]?stack|mern|back[ -]?end|front[ -]?end|node|react|web|software|polyglot/i.test(role)
  ) {
    const frameworkSignals = [
      [/\bdjango\b|\bfastapi\b/i, 'python'],
      [/asp\.net|(?:^|\W)\.net\b/i, 'dotnet'],
      [/\bflutter\b|react native/i, 'mobile']
    ].filter(([pattern]) => pattern.test(normalizedText));

    if (/node|mern/i.test(role)) {
      resumeCategory = 'fullstack';
      resumeMatchReason = 'Node/MERN role';
    } else if (frameworkSignals.length === 1) {
      resumeCategory = frameworkSignals[0][1];
      resumeMatchReason =
        'One specialized framework in broad role post';
    } else if (frameworkSignals.length === 0) {
      resumeCategory = 'fullstack';
      resumeMatchReason = 'General web/full-stack role';
    }
  }
}

const profile = {
  name: 'Muneeb Ur Rehman'
};

// Paths refer to the mounted directory INSIDE the n8n container.
const resumeCatalog = [
  {
    id: 'fullstack',
    category: 'fullstack',
    fileName: 'Muneeb_Resume_FullStack.pdf',
    path: '/files/resumes/Muneeb_Resume_FullStack.pdf',
    skills: [
      'Node.js',
      'NestJS',
      'React',
      'Next.js',
      'TypeScript',
      'Python',
      'FastAPI',
      'PostgreSQL',
      'Docker',
      'REST APIs'
    ],
    summary:
      'My work includes a multi-tenant Document Intelligence platform using Next.js, FastAPI and Azure, and Stratos, built with NestJS, Next.js and PostgreSQL.'
  },
  {
    id: 'ai',
    category: 'ai',
    fileName: 'Muneeb_Resume_AI_Engineer.pdf',
    path: '/files/resumes/Muneeb_Resume_AI_Engineer.pdf',
    skills: [
      'Python',
      'TypeScript',
      'FastAPI',
      'Node.js',
      'NestJS',
      'React',
      'Next.js',
      'Docker',
      'PostgreSQL',
      'REST APIs',
      'RAG',
      'n8n'
    ],
    summary:
      'My projects include a voice-enabled RAG assistant, a function-calling voice receptionist, and AI vision and document-processing services.'
  },
  {
    id: 'devops',
    category: 'devops',
    fileName: 'Muneeb_Resume_DevOps.pdf',
    path: '/files/resumes/Muneeb_Resume_DevOps.pdf',
    skills: [
      'Linux',
      'Docker',
      'GitHub Actions',
      'Azure',
      'Python',
      'FastAPI',
      'PostgreSQL',
      'Redis',
      'Django'
    ],
    summary:
      'My work includes multi-stage Docker builds, Docker Compose health checks, GitHub Actions workflows, and deployments integrating Azure services.'
  },
  {
    id: 'python',
    category: 'python',
    fileName: 'Muneeb_Resume_Django.pdf',
    path: '/files/resumes/Muneeb_Resume_Django.pdf',
    skills: [
      'Python',
      'Django',
      'FastAPI',
      'PostgreSQL',
      'Redis',
      'Docker',
      'REST APIs',
      'React',
      'Next.js',
      'Node.js',
      'NestJS'
    ],
    summary:
      'My projects include Django and FastAPI microservices, a Django LLM chatbot, and a real-time chat application using Django Channels and Redis.'
  },
  {
    id: 'mobile',
    category: 'mobile',
    fileName: 'Muneeb_Resume_Flutter_Mobile.pdf',
    path: '/files/resumes/Muneeb_Resume_Flutter_Mobile.pdf',
    skills: [
      'Flutter',
      'React Native',
      'Dart',
      'Node.js',
      'NestJS',
      'FastAPI',
      'React',
      'Next.js',
      'PostgreSQL',
      'Docker',
      'REST APIs'
    ],
    summary:
      'My work includes a React Native competitive gaming platform and Flutter applications using Riverpod and BLoC, backed by REST APIs.'
  },
  {
    id: 'dotnet',
    category: 'dotnet',
    fileName: 'Muneeb_Ur_Rehman_ASP.NET.pdf',
    path: '/files/resumes/Muneeb_Ur_Rehman_ASP.NET.pdf',
    skills: [
      'ASP.NET Core',
      'C#',
      'Node.js',
      'NestJS',
      'React',
      'Next.js',
      'FastAPI',
      'PostgreSQL',
      'Docker',
      'REST APIs'
    ],
    summary:
      'My ClassMate AI project uses ASP.NET Core and Next.js with PostgreSQL, Google OAuth and an AI study-guide generation pipeline.'
  }
];

const selectedResume = resumeCatalog.find(
  resume => resume.category === resumeCategory
) || null;

const reviewReasons = [];

if (!role) {
  reviewReasons.push(
    roleCandidates.length > 1
      ? 'Multiple role titles detected; choose one.'
      : 'Role title needs review.'
  );
}

if (emails.length !== 1) {
  reviewReasons.push(
    'Choose and verify the application recipient.'
  );
}

if (formCandidates.length && emails.length) {
  reviewReasons.push(
    'Both email and form are present; choose the application method.'
  );
}

if (!selectedResume) {
  reviewReasons.push(
    'No unambiguous resume match; choose a resume manually.'
  );
}

if (selectedResume) {
  reviewReasons.push(
    'Resume selected from catalogue; file existence and attachment loading have not been verified.'
  );
}

if (experience) {
  reviewReasons.push(
    'Check your experience against the requirement; no eligibility decision has been made.'
  );
}

// Mention only job skills also listed in the selected resume.
const overlappingSkills = skills.filter(skill =>
  (selectedResume?.skills || []).includes(skill)
);

const emailDraft = role && emails.length === 1
  ? {
      to: emails[0],
      subject: 'Application for ' + role,
      body:
        'Dear Hiring Team,\n\n' +
        'I would like to apply for the ' +
        role +
        ' position advertised on LinkedIn.' +
        (
          overlappingSkills.length
            ? ' My skills include ' +
              overlappingSkills.join(', ') +
              '.'
            : ''
        ) +
        (
          selectedResume?.summary
            ? ' ' + selectedResume.summary
            : ''
        ) +
        '\n\nI would welcome the opportunity to discuss my background and suitability for the role.' +
        '\n\nRegards,\n' +
        profile.name,
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

return [
  {
    json: {
      ok: true,
      parserVersion: '0.3.0',
      roleCandidate: role,
      roleCandidates,
      experience,
      location,
      workArrangement,
      skills,
      resumeCategory,
      resumeMatchReason,
      selectedResume,
      emailDraft,
      reviewReasons,
      emails,
      formCandidates,
      otherLinks: links.filter(
        link => !formCandidates.includes(link)
      ),
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
