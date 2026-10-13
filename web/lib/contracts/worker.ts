import { z } from 'zod';

/** Worker <-> API contract (SPEC "API -> Worker"). Documented in docs/worker-contract.md. */

export const WORKER_STAGES = ['download', 'probe', 'enhance', 'encode', 'upload'] as const;
export type WorkerStage = (typeof WORKER_STAGES)[number];

/** Link lifetimes. Input GET must outlive a long queue run; output PUT is requested late. */
export const INPUT_URL_TTL_SEC = 2 * 60 * 60;
export const OUTPUT_URL_TTL_SEC = 60 * 60;

const Gpu = z.object({
  name: z.string().min(1).max(200),
  vramMb: z.number().int().nonnegative(),
});

// POST /worker/claim
export const ClaimRequest = z.object({
  presets: z.array(z.string().min(1).max(100)).max(50).optional(),
  gpu: Gpu.optional(),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

export const ClaimResponse = z.object({
  jobId: z.uuid(),
  attemptId: z.uuid(),
  preset: z.object({
    id: z.string(),
    model: z.string(),
    scale: z.number(),
    /** Job params snapshot taken at creation (model, scale, maxInput, limits). */
    params: z.unknown(),
  }),
  inputUrl: z.url(),
  input: z.object({
    assetId: z.uuid(),
    sizeBytes: z.number().int().nonnegative(),
    filename: z.string(),
  }),
});
export type ClaimResponse = z.infer<typeof ClaimResponse>;

// POST /worker/jobs/{id}/heartbeat
export const HeartbeatRequest = z.object({
  attemptId: z.uuid(),
  stage: z.enum(WORKER_STAGES),
  processedFrames: z.number().int().nonnegative().optional(),
  totalFrames: z.number().int().nonnegative().optional(),
  /** ffprobe summary of the input (sent once after the probe stage). */
  probe: z.record(z.string(), z.unknown()).optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({ cancelRequested: z.boolean() });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// POST /worker/jobs/{id}/output-url
export const OutputUrlRequest = z.object({ attemptId: z.uuid() });
export type OutputUrlRequest = z.infer<typeof OutputUrlRequest>;

export const OutputUrlResponse = z.object({
  putUrl: z.url(),
  /** Headers the PUT must send (they are part of the signature). */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type OutputUrlResponse = z.infer<typeof OutputUrlResponse>;

// POST /worker/jobs/{id}/complete
export const OutputMeta = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frames: z.number().int().nonnegative(),
  fps: z.number().positive(),
  durationSec: z.number().nonnegative(),
  hasAudio: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
});
export type OutputMeta = z.infer<typeof OutputMeta>;

export const CompleteRequest = z.object({
  attemptId: z.uuid(),
  outputMeta: OutputMeta,
});
export type CompleteRequest = z.infer<typeof CompleteRequest>;

// POST /worker/jobs/{id}/fail
export const FailRequest = z.object({
  attemptId: z.uuid(),
  code: z.string().min(1).max(100),
  message: z.string().max(2000),
});
export type FailRequest = z.infer<typeof FailRequest>;
