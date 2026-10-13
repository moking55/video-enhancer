'use client';

import { useEffect, useId, useRef, useState } from 'react';

import {
  ASSETS_CHANGED_EVENT,
  checkClientLimits,
  readVideoMeta,
  type VideoMeta,
} from '@/lib/client-meta';
import { MIB } from '@/lib/contracts/presets';
import type { CreateUploadResponse } from '@/lib/contracts/uploads';

type Phase = 'idle' | 'reading' | 'ready' | 'uploading' | 'done' | 'error';

class UploadError extends Error {}

async function apiJson<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new UploadError('Network error. Check your connection and retry.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new UploadError(body?.error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

function putFile(
  target: CreateUploadResponse,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.putUrl);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      const expired =
        xhr.status === 403 || Date.now() > Date.parse(target.expiresAt)
          ? ' The upload link may have expired.'
          : '';
      reject(new UploadError(`Upload failed (${xhr.status}).${expired}`));
    };
    xhr.onerror = () => reject(new UploadError('Network error while uploading.'));
    xhr.onabort = () => reject(new UploadError('Upload was cancelled.'));
    xhr.send(file);
  });
}

function describeMeta(file: File, meta: VideoMeta): string {
  const parts = [`${(file.size / MIB).toFixed(1)} MiB`];
  if (meta.width && meta.height) parts.push(`${meta.width}x${meta.height}`);
  if (meta.durationSec) parts.push(`${meta.durationSec.toFixed(1)} s`);
  return parts.join(', ');
}

export function UploadForm() {
  const inputId = useId();
  const hintId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<VideoMeta>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [percent, setPercent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  /** Set once the bytes are stored, so a retry only needs to call complete. */
  const uploadedAssetId = useRef<string | null>(null);
  /** Guards stale metadata reads when the user picks another file quickly. */
  const selection = useRef(0);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    const token = ++selection.current;
    uploadedAssetId.current = null;
    setError(null);
    setPercent(0);
    setFile(picked);
    setMeta({});
    setProblems([]);
    if (!picked) {
      setPhase('idle');
      return;
    }
    setPhase('reading');
    const read = await readVideoMeta(picked);
    if (token !== selection.current) return;
    setMeta(read);
    setProblems(checkClientLimits(picked, read));
    setPhase('ready');
  }

  async function upload() {
    if (!file || problems.length > 0) return;
    setError(null);
    setPercent(0);
    setPhase('uploading');
    try {
      let assetId = uploadedAssetId.current;
      if (!assetId) {
        const target = await apiJson<CreateUploadResponse>('/api/v1/uploads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: file.name,
            sizeBytes: file.size,
            contentType: 'video/mp4',
            clientMeta: meta,
          }),
        });
        await putFile(target, file, (f) => setPercent(Math.round(f * 100)));
        assetId = target.assetId;
        uploadedAssetId.current = assetId;
      }
      setPercent(100);
      await apiJson(`/api/v1/assets/${assetId}/complete`, { method: 'POST' });
      uploadedAssetId.current = null;
      setPhase('done');
      setFile(null);
      setMeta({});
      if (inputRef.current) inputRef.current.value = '';
      window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
      setPhase('error');
      // An abandoned UPLOADING asset may exist; make it visible for cleanup.
      window.dispatchEvent(new Event(ASSETS_CHANGED_EVENT));
    }
  }

  const uploading = phase === 'uploading';
  const blocked = problems.length > 0;

  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
      onSubmit={(e) => {
        e.preventDefault();
        void upload();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-sm font-medium">
          Video file (MP4)
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="video/mp4,.mp4"
          onChange={onPick}
          disabled={uploading}
          aria-describedby={hintId}
          className="text-sm"
        />
        <p id={hintId} className="text-sm text-zinc-600 dark:text-zinc-400">
          MP4 only, up to 500 MiB, 120 s and 1920x1080.
        </p>
      </div>

      {phase === 'reading' ? <p role="status">Reading video details...</p> : null}

      {file && phase !== 'reading' ? (
        <p className="text-sm">
          <strong>{file.name}</strong>: {describeMeta(file, meta)}
          {meta.width ? '' : ' (resolution and duration could not be read)'}
        </p>
      ) : null}

      {blocked ? (
        <div role="alert" className="text-sm">
          <p className="font-medium">This file cannot be uploaded:</p>
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {uploading || (phase === 'error' && percent > 0) ? (
        <div className="flex items-center gap-2">
          <progress
            value={percent}
            max={100}
            aria-label="Upload progress"
            className="h-3 flex-1"
          />
          <span className="w-12 text-right text-sm tabular-nums">{percent}%</span>
        </div>
      ) : null}

      {phase === 'done' ? <p role="status">Upload complete. The file is ready below.</p> : null}

      {error ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void upload()}
            className="rounded-md border border-zinc-300 px-3 py-1 dark:border-zinc-700"
          >
            Retry upload
          </button>
        </div>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={!file || blocked || uploading || phase === 'reading' || phase === 'error'}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {uploading ? 'Uploading...' : 'Upload'}
        </button>
      </div>
    </form>
  );
}
