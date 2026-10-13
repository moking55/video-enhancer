import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { logout } from "./actions";
import { AuthError, requireUser } from "@/lib/auth";

function LogoutButton() {
  return (
    <form action={logout}>
      <button
        type="submit"
        className="rounded-md border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700"
      >
        Log out
      </button>
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
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 px-6 py-16">
        <h1 className="text-2xl font-semibold">Not allowed</h1>
        <p role="alert">This account is not allowed to use this app.</p>
        <div>
          <LogoutButton />
        </div>
      </main>
    );
  }

  return (
    <>
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <span className="font-semibold">Video Enhancer</span>
        <div className="flex items-center gap-3">
          {isOperator ? (
            <Link href="/queue" className="text-sm underline underline-offset-2">
              Queue
            </Link>
          ) : null}
          {isOperator ? (
            <Link href="/settings" className="text-sm underline underline-offset-2">
              Settings
            </Link>
          ) : null}
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {email}
          </span>
          <LogoutButton />
        </div>
      </header>
      {children}
    </>
  );
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense
      fallback={
        <p className="px-6 py-16 text-zinc-600 dark:text-zinc-400">Loading...</p>
      }
    >
      <UserGate>{children}</UserGate>
    </Suspense>
  );
}
