import { withUser } from '@/lib/auth';
import { listPresets } from '@/lib/contracts/presets';
import { json } from '@/lib/http';

const handler = withUser(async () => {
  const presets = listPresets().map(({ id, label, model, scale, maxInput, limits, note }) => ({
    id,
    label,
    model,
    scale,
    maxInput,
    limits,
    note: note ?? null,
  }));
  return json({ presets });
});

export const GET = handler;
