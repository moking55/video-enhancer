"use client";

import { useState } from "react";

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
      !window.confirm("Generating a new token revokes the current one. Continue?")
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
        setError(body?.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      setToken(body.token);
      setCreatedAt(body.createdAt);
      setActive(true);
    } catch {
      setError("Network error. Try again.");
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
      setError("Could not copy. Select the token and copy it manually.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p>
        Worker token:{" "}
        <strong>{active ? "Active" : "None"}</strong>
        {active && createdAt ? (
          <span className="text-zinc-600 dark:text-zinc-400">
            {" "}
            (created {new Date(createdAt).toLocaleString()})
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
          {busy ? "Generating..." : "Generate new token"}
        </button>
      </div>

      {error ? <p role="alert">{error}</p> : null}

      {token ? (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-300 p-4 dark:border-zinc-700">
          <label htmlFor="worker-token" className="text-sm font-medium">
            New token (shown only once)
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
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p role="status" className="text-sm">
            Store it now: it cannot be shown again.
          </p>
        </div>
      ) : null}
    </div>
  );
}
