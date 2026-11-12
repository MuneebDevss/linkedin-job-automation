export function PageHeading({eyebrow, title, description, action}: {eyebrow?: string; title: string; description: string; action?: React.ReactNode}) {
  return <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div>{eyebrow && <p className="mb-2 text-xs font-semibold uppercase tracking-[.22em] text-cyan-400">{eyebrow}</p>}<h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">{title}</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">{description}</p></div>{action}</header>;
}
