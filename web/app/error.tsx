"use client";

import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 px-4 py-10 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-semibold">เกิดข้อผิดพลาด</h1>
      <p role="alert" className="text-zinc-600 dark:text-zinc-400">
        ระบบขัดข้องชั่วคราว กรุณาลองอีกครั้ง
      </p>
      <div>
        <Button variant="primary" onClick={reset}>
          ลองอีกครั้ง
        </Button>
      </div>
    </main>
  );
}
