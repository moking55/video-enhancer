import type { Metadata } from "next";

import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = { title: "เข้าสู่ระบบ | Video Enhancer" };

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-semibold tracking-tight">เข้าสู่ระบบ</h1>
      <LoginForm />
    </main>
  );
}
