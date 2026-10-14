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
    { href: '/', label: 'อัปโหลด' },
    { href: '/jobs', label: 'งาน' },
    ...(isOperator
      ? [
          { href: '/queue', label: 'คิว' },
          { href: '/settings', label: 'ตั้งค่า' },
        ]
      : []),
  ];

  return (
    <nav aria-label="เมนูหลัก" className="min-w-0">
      <ul className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 py-1 sm:mx-0 sm:px-0">
        {items.map((item) => {
          const active = isActive(item.href, pathname);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={
                  'flex min-h-11 items-center whitespace-nowrap rounded-lg px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 sm:min-h-9 ' +
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
