'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavItem = { href: string; label: string };

/** True when `pathname` is the item's page or below it ("/" matches only itself). */
function isActive(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** Main navigation; marks the current section with `aria-current="page"`. */
export function AppNav({ isOperator }: { isOperator: boolean }) {
  const pathname = usePathname();
  const items: NavItem[] = [
    { href: '/', label: 'Upload' },
    { href: '/jobs', label: 'Jobs' },
    ...(isOperator
      ? [
          { href: '/queue', label: 'Queue' },
          { href: '/settings', label: 'Settings' },
        ]
      : []),
  ];

  return (
    <nav aria-label="Main">
      <ul className="flex flex-wrap items-center gap-1">
        {items.map((item) => {
          const active = isActive(item.href, pathname);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={
                  'rounded-md px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ' +
                  (active
                    ? 'bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800')
                }
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
