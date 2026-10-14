import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold">ไม่พบหน้าที่ต้องการ</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        หน้านี้อาจถูกลบหรือย้ายไปแล้ว หรือลิงก์ไม่ถูกต้อง
      </p>
      <p>
        <Link href="/" className="underline underline-offset-2">
          กลับหน้าแรก
        </Link>
      </p>
    </main>
  );
}
