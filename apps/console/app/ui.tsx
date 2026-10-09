import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/** The pin of the widget, as the boards draw it beside the name. */
export function Mark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
      <path d="M 64 121.9 L 30.1 87.9 A 48 48 0 1 1 97.9 87.9 Z" fill="#dd2c27" />
    </svg>
  );
}

type Tone = 'primary' | 'outline' | 'danger' | 'quiet';

const TONES: Record<Tone, string> = {
  primary: 'bg-accent text-white hover:bg-accent-strong disabled:bg-faint',
  outline: 'border border-ink/80 bg-surface text-ink hover:bg-chip disabled:border-line disabled:text-faint',
  danger: 'border border-accent/60 bg-surface text-accent hover:bg-accent/5',
  quiet: 'text-muted hover:text-ink',
};

export function Button({
  tone = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${TONES[tone]} ${className}`}
      {...props}
    />
  );
}

/** The wide outlined buttons of the sign-in card. */
export function WideButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="flex h-11 w-full items-center justify-center rounded-lg border border-ink/70 bg-surface text-sm font-semibold text-ink hover:bg-chip disabled:cursor-not-allowed disabled:border-line disabled:text-faint"
      {...props}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-muted">{label}</span>
      <input
        className="h-10 w-full rounded-md border border-line bg-surface px-3 text-[15px] text-ink placeholder:text-faint focus:border-ink/60 focus:outline-none"
        {...props}
      />
      {hint === undefined ? null : <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[14px] border border-line bg-surface ${className}`}>{children}</section>;
}

/** The small label of a role or a state, as the members table draws it. */
export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'done' }) {
  const colours = {
    neutral: 'bg-chip text-ink',
    accent: 'bg-accent/10 text-accent-strong',
    done: 'bg-done/10 text-done',
  }[tone];

  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${colours}`}>{children}</span>;
}

/** A problem said where it happened, with what to do about it. */
export function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-accent-strong">
      {children}
    </p>
  );
}

/** A name and its initial, in the round chip of the boards. */
export function Initial({ name }: { name: string }) {
  return (
    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-chip text-xs font-semibold text-ink">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
