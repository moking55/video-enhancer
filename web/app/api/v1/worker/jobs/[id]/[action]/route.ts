import { z } from 'zod';

import {
  CompleteRequest,
  FailRequest,
  HeartbeatRequest,
  OutputUrlRequest,
} from '@/lib/contracts/worker';
import { apiError, json } from '@/lib/http';
import { withWorker } from '@/lib/worker-auth';
import {
  complete,
  failJob,
  heartbeat,
  outputUrl,
  type WorkerJobResult,
} from '@/lib/worker-jobs';

type Ctx = RouteContext<'/api/v1/worker/jobs/[id]/[action]'>;

export const POST = withWorker<Ctx>(async ({ admin }, request, ctx) => {
  const { id: jobId, action } = await ctx.params;
  if (action !== 'heartbeat' && action !== 'output-url' && action !== 'complete' && action !== 'fail') {
    return apiError(404, 'NOT_FOUND', 'Unknown action');
  }
  if (!z.uuid().safeParse(jobId).success) return apiError(404, 'NOT_FOUND', 'Job not found');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, 'INVALID_JSON', 'Request body must be JSON');
  }

  const job = { admin, jobId };
  const invalid = (e: z.ZodError) => apiError(400, 'VALIDATION', 'Invalid request', e.issues);
  const respond = <T>(result: WorkerJobResult<T>) =>
    result.ok ? json(result.data) : apiError(result.status, result.code, result.message);

  switch (action) {
    case 'heartbeat': {
      const p = HeartbeatRequest.safeParse(body);
      return p.success ? respond(await heartbeat(job, p.data)) : invalid(p.error);
    }
    case 'output-url': {
      const p = OutputUrlRequest.safeParse(body);
      return p.success ? respond(await outputUrl(job, p.data.attemptId)) : invalid(p.error);
    }
    case 'complete': {
      const p = CompleteRequest.safeParse(body);
      return p.success ? respond(await complete(job, p.data)) : invalid(p.error);
    }
    case 'fail': {
      const p = FailRequest.safeParse(body);
      return p.success ? respond(await failJob(job, p.data)) : invalid(p.error);
    }
  }
});
