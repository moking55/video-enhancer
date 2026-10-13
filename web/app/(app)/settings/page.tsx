import { Suspense } from "react";

import { WorkerTokenPanel } from "@/components/worker-token-panel";
import { requireUser } from "@/lib/auth";
import { getWorkerTokenInfo } from "@/lib/worker-tokens";

/**
 * Reads the session + DB (request-time), so it sits inside <Suspense>. The
 * worker-token UI is rendered only for operators; others see a short notice.
 */
async function OperatorSettings() {
  const { supabase, userId, isOperator } = await requireUser();
  if (!isOperator) {
    return (
      <p role="alert" className="text-zinc-600 dark:text-zinc-400">
        Operator only. Ask the operator if you need access to this page.
      </p>
    );
  }
  const info = await getWorkerTokenInfo(supabase, userId);
  return (
    <section aria-labelledby="worker-token-heading" className="flex flex-col gap-3">
      <h2 id="worker-token-heading" className="text-lg font-medium">
        Colab worker token
      </h2>
      <p className="text-zinc-600 dark:text-zinc-400">
        Put the token in Colab Secrets as <code>ENHANCER_TOKEN</code>. Generating a
        new one revokes the old one.
      </p>
      <WorkerTokenPanel initialActive={info.active} initialCreatedAt={info.createdAt} />
    </section>
  );
}

export default function SettingsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <Suspense
        fallback={<p className="text-zinc-600 dark:text-zinc-400">Loading...</p>}
      >
        <OperatorSettings />
      </Suspense>
    </main>
  );
}
