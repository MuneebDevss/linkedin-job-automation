const b = $json.body || {};

if (
  typeof b.text !== 'string' ||
  !b.text.trim() ||
  b.text.length > 50000
) {
  throw new Error('Provide post text (1–50,000 characters).');
}

const text = b.text.trim();
const normalizedText = text.normalize('NFKC');

const lines = normalizedText
  .split(/\n/)
  .map(line => line.trim())
  .filter(Boolean);

// -------------------- Emails and links --------------------

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

// -------------------- Company --------------------
// Extract from explicit company information.
// Do not assume an email domain or job-board name is the employer.

function cleanCompany(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s*\((?:private|pvt\.?)\)\s*/ig, ' ')
    .replace(/\b(?:private|pvt\.?|limited|ltd\.?)\b\.?/ig, '')
    .replace(/\s+/g, ' ')
    .replace(/[|:—–-]+$/, '')
    .trim();
}

let company = typeof b.company === 'string'
  ? cleanCompany(b.company)
  : null;

let companySource = company ? 'provided' : null;

if (!company) {
  const companyPatterns = [
    /^company\s*:\s*(.+)$/i,
    /^(.{2,100}?)\s+(?:is|are)\s+(?:hiring|seeking|looking\s+for)\b/i,
    /^(.{2,100}?)\s*[-–—|:]\s*(?:we(?:'|’)re\s+)?hiring\b/i
  ];

  for (const line of lines.slice(0, 12)) {
    for (const pattern of companyPatterns) {
      const match = line.match(pattern);
      if (!match) continue;

      const candidate = cleanCompany(match[1]);

      if (
        candidate &&
        !/^(we|we are|we're|we’re|our client|a company|the company)$/i.test(candidate)
      ) {
        company = candidate;
        companySource = 'post text';
        break;
      }
    }

    if (company) break;
  }
}

company = company || null;

// -------------------- Role --------------------

const rolePattern = /(?<!\w)(?:(?:senior|junior|jr\.?|sr\.?|associate|lead|mid[ -]level|staff|principal)\s+)?(?:(?:full[ -]?stack|back[ -]?end|front[ -]?end|software|web|mobile|android|ios|flutter|react(?:\s+native)?|node(?:\.js)?|mern(?:\s+stack)?|python|django|fastapi|ASP\.NET(?:\s+Core)?|\.?NET|C#|AI|machine learning|devops|data|QA|SQA|polyglot)(?:\s*(?:\/|\+|&|and)\s*(?:react|angular|node(?:\.js)?|nest(?:js)?))?\s+)+(?:developers?|engineers?|interns?)\b/ig;

const headings = lines.filter(line =>
  /hiring|position\s*:|role\s*:|job title\s*:|vacanc/i.test(line)
);

// Prefer explicit hiring headings if they contain a recognizable role.
const headingHasRole = headings.some(line =>
  [...line.matchAll(rolePattern)].length > 0
);

const titleLines = headingHasRole
  ? headings
  : lines.slice(0, 5).filter(line =>
      !/^[-•]/.test(line) && line.length < 160
    );

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

// -------------------- Experience --------------------

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

// -------------------- Location --------------------

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

// -------------------- Skills --------------------

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

// -------------------- Resume category --------------------

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

// -------------------- Resume catalogue --------------------

const profile = {
  name: 'Muneeb Ur Rehman'
};

const resumeCatalog = [
  {
    id: 'fullstack',
    category: 'fullstack',
    fileName: 'Muneeb_Resume_FullStack.pdf',
    path: '/files/resumes/Muneeb_Resume_FullStack.pdf',
    skills: [
      'Node.js', 'NestJS', 'React', 'Next.js', 'TypeScript',
      'Python', 'FastAPI', 'PostgreSQL', 'Docker', 'REST APIs'
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
      'Python', 'TypeScript', 'FastAPI', 'Node.js', 'NestJS',
      'React', 'Next.js', 'Docker', 'PostgreSQL',
      'REST APIs', 'RAG', 'n8n'
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
      'Linux', 'Docker', 'GitHub Actions', 'Azure', 'Python',
      'FastAPI', 'PostgreSQL', 'Redis', 'Django'
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
      'Python', 'Django', 'FastAPI', 'PostgreSQL', 'Redis',
      'Docker', 'REST APIs', 'React', 'Next.js', 'Node.js', 'NestJS'
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
      'Flutter', 'React Native', 'Dart', 'Node.js', 'NestJS',
      'FastAPI', 'React', 'Next.js', 'PostgreSQL', 'Docker',
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
      'ASP.NET Core', 'C#', 'Node.js', 'NestJS', 'React',
      'Next.js', 'FastAPI', 'PostgreSQL', 'Docker', 'REST APIs'
    ],
    summary:
      'My ClassMate AI project uses ASP.NET Core and Next.js with PostgreSQL, Google OAuth and an AI study-guide generation pipeline.'
  }
];

const selectedResume = resumeCatalog.find(
  resume => resume.category === resumeCategory
) || null;

// -------------------- Review reasons --------------------

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

// -------------------- Email draft --------------------

const overlappingSkills = skills.filter(skill =>
  (selectedResume?.skills || []).includes(skill)
);

const formatList = (items) =>
  items.length <= 2
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;

const buildEmailBody = () => {
  const skillsLine = overlappingSkills.length
    ? `My experience with ${formatList(overlappingSkills)} aligns closely with the requirements of this role.`
    : '';

  const summaryLine = selectedResume?.summary?.trim() || '';

  const attachmentLine = selectedResume?.fileName
    ? 'I have attached my resume for your review.'
    : '';

  const signature = [
    profile.name,
    profile.email || 'munib.urehmann@gmail.com',
    'GitHub: github.com/MuneebDevss',
    'LinkedIn: linkedin.com/in/muneeb-ur-rehman-971b42313/'
  ].filter(Boolean).join('\n');

  return [
    'Dear Hiring Team,',
    `I am writing to express my interest in the ${role} position at your organization.`,
    [skillsLine, summaryLine].filter(Boolean).join(' '),
    [
      attachmentLine,
      'I would welcome the opportunity to discuss how my background and skills can contribute to your team.'
    ].filter(Boolean).join(' '),
    'Thank you for your time and consideration. I look forward to hearing from you.',
    `Kind regards,\n${signature}`
  ]
    .filter(Boolean)
    .join('\n\n');
};

const emailDraft = role && emails.length === 1
  ? {
      to: emails[0],
      subject: `Application for ${role} – ${profile.name}`,
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

// -------------------- Application identity --------------------
// Matches the app-v1 algorithm used to backfill the tracker.
// Independent of the LinkedIn post URL.

function makeApplicationIdentity({
  role,
  location,
  emails = [],
  company,
  deadlineText = '',
  formLinks = []
}) {
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
      .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
      .trim();

  const roleKey = normalize(role).replace(/^ai first /, '');
  const normalizedLocation = normalize(location);

  const cities = [
    'islamabad',
    'rawalpindi',
    'lahore',
    'karachi',
    'multan',
    'peshawar',
    'faisalabad',
    'quetta',
    'sialkot'
  ];

  const matchingCities = cities.filter(city =>
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

  const addresses = [
    ...new Set(
      emails.map(email => String(email).trim().toLowerCase())
    )
  ];

  const deadlineLine =
    String(deadlineText)
      .normalize('NFKC')
      .split(/\n/)
      .find(line =>
        /deadline|closing date|apply (?:by|before)/i.test(line)
      ) || '';

  const months = {
    jan: 1, feb: 2, mar: 3, apr: 4,
    may: 5, jun: 6, jul: 7, aug: 8,
    sep: 9, oct: 10, nov: 11, dec: 12
  };

  let year;
  let month;
  let day;
  let match;
  let deadline = null;

  if (
    (match = deadlineLine.match(
      /\b(20\d{2})-(\d{2})-(\d{2})\b/
    ))
  ) {
    [, year, month, day] = match;
  } else if (
    (match = deadlineLine.match(
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)[,\s]+(20\d{2})\b/
    ))
  ) {
    day = match[1];
    month = months[match[2].slice(0, 3).toLowerCase()];
    year = match[3];
  } else if (
    (match = deadlineLine.match(
      /\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/
    ))
  ) {
    month = months[match[1].slice(0, 3).toLowerCase()];
    day = match[2];
    year = match[3];
  }

  if (year && month && day) {
    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day))
    );

    if (
      date.getUTCFullYear() === Number(year) &&
      date.getUTCMonth() === Number(month) - 1 &&
      date.getUTCDate() === Number(day)
    ) {
      deadline = date.toISOString().slice(0, 10);
    }
  }

  const warnings = [];

  let method;
  let destination;

  if (addresses.length === 1) {
    method = 'email';
    destination = addresses[0];
  } else if (addresses.length > 1) {
    warnings.push(
      'Multiple emails: choose the application recipient before generating an ID.'
    );
  } else if (formLinks.length === 1) {
    method = 'form';
    destination = String(formLinks[0]).trim().split('#')[0];

    const parts = destination.split('?');

    const query = (parts[1] || '')
      .split('&')
      .filter(parameter =>
        parameter &&
        !/^(utm_[^=]*|trk|trackingid|fbclid|gclid)=/i.test(parameter)
      )
      .sort();

    destination =
      parts[0].replace(/\/$/, '') +
      (query.length ? '?' + query.join('&') : '');
  } else if (formLinks.length > 1) {
    warnings.push('Multiple forms: choose the application form.');
  } else if (companyKey) {
    method = 'company';
    destination = companyKey;

    warnings.push(
      'Company fallback: cannot exactly match an email/form ID until the destination is backfilled.'
    );
  }

  if (!roleKey) {
    warnings.push('Role missing.');
  }

  if (locationKey === 'unknown') {
    warnings.push(
      'Location missing: cannot distinguish offices.'
    );
  }

  if (!deadline) {
    warnings.push(
      'Deadline missing: repeated hiring cycles require manual review.'
    );
  }

  const baseKey = destination && roleKey
    ? [
        'app-v1',
        method,
        destination,
        roleKey,
        locationKey
      ].map(encodeURIComponent).join('|')
    : null;

  return {
    applicationId: baseKey
      ? baseKey + '|' + (deadline || 'no-deadline')
      : null,
    applicationBaseKey: baseKey,
    applicationDeadline: deadline,
    applicationIdMethod: method || null,
    applicationIdWarnings: warnings
  };
}

const identity = makeApplicationIdentity({
  role,
  location: location || workArrangement,
  emails,
  company,
  deadlineText: normalizedText,
  formLinks: formCandidates
});

if (!identity.applicationId) {
  throw new Error(
    'Cannot generate Application ID: confirm one role and one application destination.'
  );
}

if (!company) {
  reviewReasons.push(
    'Company could not be extracted; confirm it manually.'
  );
}

reviewReasons.push(...identity.applicationIdWarnings);

// -------------------- Output --------------------

return [
  {
    json: {
      ok: true,
      parserVersion: '0.3.2',

      ...identity,

      company,
      companySource,

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
