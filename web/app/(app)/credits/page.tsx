import type { Metadata } from "next";

import { getPreset } from "@/lib/contracts/presets";
import {
  ARCHITECTURE_CREDITS,
  CREDITS_NOTICE_EN,
  CREDITS_NOTICE_TH,
  MODEL_CREDITS,
} from "@/lib/model-credits";

export const metadata: Metadata = { title: "เครดิตโมเดล | Video Enhancer" };

const link =
  "underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";

/** Static page: attribution for every model used by the presets (CC BY 4.0 / BSD-3-Clause). */
export default function CreditsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">เครดิตโมเดล</h1>
      <section className="flex flex-col gap-2">
        <p>{CREDITS_NOTICE_TH}</p>
        <p lang="en" className="text-sm text-zinc-600 dark:text-zinc-400">
          {CREDITS_NOTICE_EN}
        </p>
      </section>

      <section aria-labelledby="models-heading" className="flex flex-col gap-3">
        <h2 id="models-heading" className="text-lg font-medium">
          โมเดลที่ใช้
        </h2>
        <ul className="flex flex-col gap-4">
          {MODEL_CREDITS.map((c) => (
            <li key={c.model} className="flex flex-col">
              <span className="font-medium">
                {c.model}{" "}
                <span className="text-sm font-normal text-zinc-600 dark:text-zinc-400">
                  (preset: {getPreset(c.presetId)?.label ?? c.presetId})
                </span>
              </span>
              <span className="text-sm text-zinc-700 dark:text-zinc-300">ผู้สร้าง: {c.author}</span>
              <span className="text-sm text-zinc-700 dark:text-zinc-300">
                สัญญาอนุญาต:{" "}
                <a href={c.licence.url} target="_blank" rel="noopener noreferrer" className={link}>
                  {c.licence.name}
                </a>
                {" · "}
                <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className={link}>
                  แหล่งที่มา
                </a>
              </span>
              {c.note ? (
                <span className="text-sm text-zinc-600 dark:text-zinc-400">{c.note}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="arch-heading" className="flex flex-col gap-2">
        <h2 id="arch-heading" className="text-lg font-medium">
          สถาปัตยกรรมและเครื่องมือ
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-zinc-700 dark:text-zinc-300">
          {ARCHITECTURE_CREDITS.map((a) => (
            <li key={a.name}>
              {a.url ? (
                <a href={a.url} target="_blank" rel="noopener noreferrer" className={link}>
                  {a.text}
                </a>
              ) : (
                a.text
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
