import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import CreditsPage from '@/app/(app)/credits/page';
import { listPresets } from '@/lib/contracts/presets';
import { ARCHITECTURE_CREDITS, CREDITS_NOTICE_TH, MODEL_CREDITS } from '@/lib/model-credits';

const realPresets = () => listPresets().filter((p) => !p.devOnly);

describe('model credits', () => {
  it('lists every model of every preset exactly once, linked to the right preset', () => {
    const credited = MODEL_CREDITS.map((c) => c.model).sort();
    expect(credited).toEqual(realPresets().map((p) => p.model).sort());
    for (const c of MODEL_CREDITS) {
      expect(realPresets().find((p) => p.id === c.presetId)?.model).toBe(c.model);
    }
  });

  it('gives author, licence and an https source link for each model', () => {
    for (const c of MODEL_CREDITS) {
      expect(c.author.length).toBeGreaterThan(0);
      expect(['CC BY 4.0', 'BSD-3-Clause']).toContain(c.licence.name);
      expect(c.licence.url).toMatch(/^https:\/\//);
      expect(c.sourceUrl).toMatch(/^https:\/\//);
    }
    const ccBy = MODEL_CREDITS.filter((c) => c.licence.name === 'CC BY 4.0');
    expect(ccBy.map((c) => c.model).sort()).toEqual([
      '2xHFA2kAVCCompact',
      '2xNomosUni_span_multijpg',
      '4xNomosUni_span_multijpg',
      '4xNomosWebPhoto_RealPLKSR',
    ]);
    expect(ccBy.every((c) => c.author.includes('Philip Hofmann'))).toBe(true);
    expect(ccBy.every((c) => c.licence.url === 'https://creativecommons.org/licenses/by/4.0/')).toBe(
      true,
    );
    expect(MODEL_CREDITS.filter((c) => c.licence.name === 'BSD-3-Clause')).toHaveLength(4);
  });
});

describe('credits page', () => {
  const html = renderToStaticMarkup(createElement(CreditsPage));

  it('renders the heading, the CC BY notice and every model with its links', () => {
    expect(html).toContain('เครดิตโมเดล');
    expect(html).toContain(CREDITS_NOTICE_TH.slice(0, 40));
    expect(html).toContain('ไม่มีการแก้ไข');
    for (const c of MODEL_CREDITS) {
      expect(html).toContain(c.model);
      expect(html).toContain(`href="${c.sourceUrl}"`);
    }
    expect(html).toContain('href="https://creativecommons.org/licenses/by/4.0/"');
    expect(html).toContain('href="https://opensource.org/license/bsd-3-clause"');
    expect(html).toContain('Philip Hofmann');
    for (const a of ARCHITECTURE_CREDITS) expect(html).toContain(a.text);
  });

  it('shows the Thai preset labels and opens external links safely', () => {
    expect(html).toContain('เร็ว 2× (อนิเมะ)');
    expect(html).toContain('คุณภาพ 4× (ภาพจริง)');
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    expect(anchors.length).toBeGreaterThan(8);
    for (const a of anchors) expect(a).toContain('rel="noopener noreferrer"');
  });
});
