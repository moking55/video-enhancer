"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold">เกิดข้อผิดพลาด</h1>
      <p role="alert" className="text-zinc-600 dark:text-zinc-400">
        ระบบขัดข้องชั่วคราว กรุณาลองอีกครั้ง
      </p>
      <div>
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
        >
          ลองอีกครั้ง
        </button>
      </div>
    </main>
  );
}
