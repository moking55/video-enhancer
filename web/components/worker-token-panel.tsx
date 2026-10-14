"use client";

import { useState } from "react";

import { formatDateTime } from "@/components/job-format";
import { apiErrorText } from "@/lib/error-messages";

type Props = { initialActive: boolean; initialCreatedAt: string | null };

export function WorkerTokenPanel({ initialActive, initialCreatedAt }: Props) {
  const [active, setActive] = useState(initialActive);
  const [createdAt, setCreatedAt] = useState(initialCreatedAt);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    if (
      active &&
      !window.confirm("การสร้าง token ใหม่จะทำให้ token ปัจจุบันใช้ไม่ได้อีก ต้องการดำเนินการต่อหรือไม่?")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/v1/worker-tokens", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(apiErrorText(body, `ส่งคำขอไม่สำเร็จ (${res.status})`));
        return;
      }
      setToken(body.token);
      setCreatedAt(body.createdAt);
      setActive(true);
    } catch {
      setError("เชื่อมต่อไม่ได้ กรุณาลองอีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setError("คัดลอกไม่สำเร็จ กรุณาเลือก token แล้วคัดลอกด้วยตัวเอง");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p>
        Worker token:{" "}
        <strong>{active ? "ใช้งานอยู่" : "ยังไม่มี"}</strong>
        {active && createdAt ? (
          <span className="text-zinc-600 dark:text-zinc-400">
            {" "}
            (สร้างเมื่อ {formatDateTime(createdAt)})
          </span>
        ) : null}
      </p>

      <div>
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {busy ? "กำลังสร้าง..." : "สร้าง token ใหม่"}
        </button>
      </div>

      {error ? <p role="alert">{error}</p> : null}

      {token ? (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
          <label htmlFor="worker-token" className="text-sm font-medium">
            Token ใหม่ (แสดงครั้งเดียวเท่านั้น)
          </label>
          <div className="flex gap-2">
            <input
              id="worker-token"
              readOnly
              value={token}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 font-mono text-sm dark:border-zinc-700"
            />
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
            >
              {copied ? "คัดลอกแล้ว" : "คัดลอก"}
            </button>
          </div>
          <p role="status" className="text-sm">
            กรุณาคัดลอกหรือบันทึกไว้ทันที เนื่องจากจะไม่แสดงอีก
          </p>
        </div>
      ) : null}
    </div>
  );
}
