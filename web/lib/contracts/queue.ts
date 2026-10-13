import { z } from 'zod';

import { JOB_STATES } from '@/lib/contracts/jobs';

/** Finished jobs shown on the operator queue page: newest N within the window. */
export const QUEUE_FINISHED_LIMIT = 20;
export const QUEUE_FINISHED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One row of the operator queue. Never carries URLs, object keys or attempt ids. */
export const QueueItem = z.object({
  id: z.uuid(),
  state: z.enum(JOB_STATES),
  presetId: z.string(),
  stage: z.string().nullable(),
  processedFrames: z.number().int().nullable(),
  totalFrames: z.number().int().nullable(),
  stale: z.boolean(),
  createdAt: z.string(),
  ownerEmail: z.string().nullable(),
  filename: z.string().nullable(),
});
export type QueueItem = z.infer<typeof QueueItem>;

export type QueueResponse = { jobs: QueueItem[] };
