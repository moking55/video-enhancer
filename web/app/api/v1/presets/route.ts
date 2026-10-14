import { withUser } from '@/lib/auth';
import { listPresets } from '@/lib/contracts/presets';
import { json } from '@/lib/http';

const handler = withUser(async () => {
  const presets = listPresets().map(
    ({ id, label, model, scale, maxInput, limits, note, secPerMegapixelFrame }) => ({
      id,
      label,
      model,
      scale,
      maxInput,
      limits,
      // Lets the client estimate processing time (see estimateProcessingSec).
      secPerMegapixelFrame,
      note: note ?? null,
    }),
  );
  return json({ presets });
});

export const GET = handler;
