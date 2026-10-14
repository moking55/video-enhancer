import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg text-center font-medium leading-tight transition-colors select-none ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-300 ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-blue-600 font-semibold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800 ' +
    'dark:bg-blue-500 dark:hover:bg-blue-400 dark:active:bg-blue-600',
  secondary:
    'border border-zinc-400 bg-white text-zinc-900 hover:bg-zinc-100 active:bg-zinc-200 ' +
    'dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:active:bg-zinc-700',
  danger:
    'border border-red-600 bg-white text-red-700 hover:bg-red-50 active:bg-red-100 ' +
    'dark:border-red-400 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950 dark:active:bg-red-900',
  ghost:
    'text-zinc-800 hover:bg-zinc-100 active:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:active:bg-zinc-700',
};

/** Touch targets are at least 44 px high on phones; `sm` relaxes to 36 px on desktop. */
const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-11 px-3 py-1.5 text-sm sm:min-h-9',
  md: 'min-h-11 px-4 py-2 text-sm',
  lg: 'min-h-12 px-6 py-3 text-base',
};

/** Class string of the button style system; also usable on `<Link>` / `<a>`. */
export function buttonClass(
  opts: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean; className?: string } = {},
): string {
  const { variant = 'secondary', size = 'md', fullWidth = false, className } = opts;
  return [BASE, VARIANT[variant], SIZE[size], fullWidth ? 'w-full' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
};

/** Shared button. Defaults to `type="button"` so it never submits a form by accident. */
export function Button({
  variant,
  size,
  fullWidth,
  className,
  type = 'button',
  ...rest
}: Props) {
  return <button type={type} className={buttonClass({ variant, size, fullWidth, className })} {...rest} />;
}
