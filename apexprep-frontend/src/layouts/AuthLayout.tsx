import type { ReactNode } from 'react'
import { Logo } from '@/components/Logo'

export function AuthLayout({ title, subtitle, children, aside }: { title: string; subtitle: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="min-h-screen bg-deck lg:grid lg:grid-cols-2">
      <div className="flex min-h-screen flex-col justify-center px-6 py-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <Logo className="mb-8" />
          <h1 className="text-headline-lg text-ink">{title}</h1>
          <p className="mt-1 text-body-sm text-ink-muted">{subtitle}</p>
          <div className="mt-7">{children}</div>
        </div>
      </div>
      <div className="hidden border-l border-line bg-canvas lg:flex lg:flex-col lg:justify-center lg:px-16">
        {aside ?? <DefaultAside />}
      </div>
    </div>
  )
}

function DefaultAside() {
  const points = [
    ['Adaptive difficulty', 'Every set recalibrates across L1–L5 as your streak builds.'],
    ['AI explanations', 'Step-by-step solutions, key concept and the common mistake — on every question.'],
    ['Weak-topic radar', 'Retention decay is tracked per topic so revision is scheduled, not guessed.'],
    ['Six tracks', 'JEE, NEET and the Physics, Chemistry, Mathematics and Astronomy Olympiads.'],
  ]
  return (
    <div className="max-w-md">
      <p className="eyebrow">Precision Academic Telemetry</p>
      <h2 className="mt-3 text-headline-lg text-ink">Built for the top tier of competitive preparation.</h2>
      <dl className="mt-8 space-y-5">
        {points.map(([t, d]) => (
          <div key={t} className="border-l-2 border-primary pl-4">
            <dt className="text-body-md font-semibold text-ink">{t}</dt>
            <dd className="mt-0.5 text-body-sm text-ink-muted">{d}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
