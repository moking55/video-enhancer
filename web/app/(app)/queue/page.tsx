import { Suspense } from "react";

import { QueueBoard } from "@/components/queue-board";
import { requireUser } from "@/lib/auth";

/** Reads the session (request-time), so it sits inside <Suspense>. */
async function OperatorQueue() {
  const { isOperator } = await requireUser();
  if (!isOperator) {
    return (
      <p role="alert" className="text-zinc-600 dark:text-zinc-400">
        เฉพาะผู้ดูแลระบบเท่านั้น หากต้องการใช้งานหน้านี้ กรุณาติดต่อผู้ดูแลระบบ
      </p>
    );
  }
  return <QueueBoard />;
}

export default function QueuePage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-2xl font-semibold tracking-tight">คิว</h1>
      <Suspense fallback={<p className="text-zinc-600 dark:text-zinc-400">กำลังโหลด...</p>}>
        <OperatorQueue />
      </Suspense>
    </main>
  );
}
