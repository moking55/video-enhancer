import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { logout } from "./actions";
import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";
import { AuthError, requireUser } from "@/lib/auth";

function LogoutButton() {
  return (
    <form action={logout}>
      <Button type="submit" variant="secondary" size="sm" className="shrink-0 whitespace-nowrap">
        ออกจากระบบ
      </Button>
    </form>
  );
}

/**
 * Reads the session cookie (request-time data), so with cacheComponents it
 * must sit inside <Suspense>; the shell outside it is prerendered.
 */
async function UserGate({ children }: { children: ReactNode }) {
  let email: string;
  let isOperator: boolean;
  try {
    ({ email, isOperator } = await requireUser());
  } catch (err) {
    if (!(err instanceof AuthError) || err.code === "SERVER_MISCONFIGURED") {
      throw err;
    }
    if (err.code === "UNAUTHENTICATED") redirect("/login");
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 px-4 py-16 sm:px-6">
        <h1 className="text-2xl font-semibold">ไม่มีสิทธิ์เข้าใช้งาน</h1>
        <p role="alert">บัญชีนี้ไม่มีสิทธิ์ใช้งานแอปนี้</p>
        <div>
          <LogoutButton />
        </div>
      </main>
    );
  }

  return (
    <>
      {/* Phones: brand + email + logout on row 1, scrollable nav on row 2. From sm: one row. */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-zinc-200 px-4 py-2 sm:flex-nowrap sm:px-6 dark:border-zinc-800">
        <Link
          href="/"
          className="order-1 shrink-0 rounded-md py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Video Enhancer
        </Link>
        <div className="order-2 ml-auto flex min-w-0 items-center gap-3 sm:order-3">
          <span
            title={email}
            className="min-w-0 truncate text-sm text-zinc-600 sm:max-w-64 dark:text-zinc-400"
          >
            {email}
          </span>
          <LogoutButton />
        </div>
        <div className="order-3 w-full min-w-0 sm:order-2 sm:w-auto sm:flex-1">
          <AppNav isOperator={isOperator} />
        </div>
      </header>
      {children}
      <footer className="border-t border-zinc-200 px-4 py-4 text-sm text-zinc-600 sm:px-6 dark:border-zinc-800 dark:text-zinc-400">
        <Link
          href="/credits"
          className="inline-flex min-h-11 items-center rounded-md underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          เครดิตโมเดล
        </Link>
      </footer>
    </>
  );
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense
      fallback={
        <p className="px-4 py-16 text-zinc-600 sm:px-6 dark:text-zinc-400">กำลังโหลด...</p>
      }
    >
      <UserGate>{children}</UserGate>
    </Suspense>
  );
}
