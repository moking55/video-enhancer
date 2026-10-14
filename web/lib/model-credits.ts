/**
 * Attribution for every model the presets use (CC-BY-4.0 requires credit, a licence link and a statement of
 * changes). Source of truth: docs/research/spandrel-models.md (section 5) and the Real-ESRGAN repository.
 * tests/model-credits.test.ts fails when a preset's model is missing here.
 */

export type ModelCredit = {
  /** Model name = `Preset.model`. */
  model: string;
  /** Preset that uses it. */
  presetId: string;
  author: string;
  licence: { name: string; url: string };
  sourceUrl: string;
  /** Extra credit line (dataset, upstream training recipe). */
  note?: string;
};

const BSD3 = { name: 'BSD-3-Clause', url: 'https://opensource.org/license/bsd-3-clause' };
const CC_BY_4 = { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' };
const REAL_ESRGAN = 'https://github.com/xinntao/Real-ESRGAN';
const REAL_ESRGAN_AUTHOR = 'Xintao Wang และคณะ (Real-ESRGAN)';
const HOFMANN = 'Philip Hofmann (Phhofm / Phips)';
const hf = (repo: string) => `https://huggingface.co/Phips/${repo}`;

export const MODEL_CREDITS: readonly ModelCredit[] = [
  {
    model: '2xNomosUni_span_multijpg',
    presetId: 'span-fast-x2',
    author: HOFMANN,
    licence: CC_BY_4,
    sourceUrl: hf('2xNomosUni_span_multijpg'),
  },
  {
    model: 'realesr-general-x4v3',
    presetId: 'realesrgan-fast-x4',
    author: REAL_ESRGAN_AUTHOR,
    licence: BSD3,
    sourceUrl: REAL_ESRGAN,
  },
  {
    model: '4xNomosUni_span_multijpg',
    presetId: 'span-balanced-x4',
    author: HOFMANN,
    licence: CC_BY_4,
    sourceUrl: hf('4xNomosUni_span_multijpg'),
  },
  {
    model: 'RealESRGAN_x2plus',
    presetId: 'realesrgan-x2',
    author: REAL_ESRGAN_AUTHOR,
    licence: BSD3,
    sourceUrl: REAL_ESRGAN,
  },
  {
    model: '4xNomosWebPhoto_RealPLKSR',
    presetId: 'plksr-quality-x4',
    author: HOFMANN,
    licence: CC_BY_4,
    sourceUrl: hf('4xNomosWebPhoto_RealPLKSR'),
  },
  {
    model: 'RealESRGAN_x4plus',
    presetId: 'realesrgan-x4',
    author: REAL_ESRGAN_AUTHOR,
    licence: BSD3,
    sourceUrl: REAL_ESRGAN,
  },
  {
    model: '2xHFA2kAVCCompact',
    presetId: 'compact-anime-x2',
    author: HOFMANN,
    licence: CC_BY_4,
    sourceUrl: hf('2xHFA2kAVCCompact'),
    note: 'ฝึกด้วยชุดข้อมูล HFA2k ของ musl',
  },
  {
    model: 'realesr-animevideov3',
    presetId: 'realesrgan-anime-x4',
    author: REAL_ESRGAN_AUTHOR,
    licence: BSD3,
    sourceUrl: REAL_ESRGAN,
  },
];

/** Courtesy credits for the architectures and the loader (no licence terms are claimed for them here). */
export const ARCHITECTURE_CREDITS: readonly { name: string; text: string; url?: string }[] = [
  { name: 'SPAN', text: 'สถาปัตยกรรม SPAN (Apache-2.0)', url: 'https://github.com/hongyuanyu/SPAN' },
  { name: 'RealPLKSR', text: 'สถาปัตยกรรม PLKSR / RealPLKSR' },
  { name: 'SRVGGNetCompact', text: 'Real-ESRGAN Compact (SRVGGNetCompact, BSD-3-Clause)', url: REAL_ESRGAN },
  { name: 'spandrel', text: 'โหลดโมเดลผ่าน spandrel โดย chaiNNer-org (MIT)', url: 'https://github.com/chaiNNer-org/spandrel' },
];

/** Shown above the list: what CC-BY 4.0 asks for (credit, licence link, changes, no endorsement). */
export const CREDITS_NOTICE_TH =
  'โมเดลของ Philip Hofmann ใช้ภายใต้สัญญาอนุญาต Creative Commons Attribution 4.0 International (CC BY 4.0) ' +
  'แอปนี้ใช้ไฟล์น้ำหนักโมเดลตามที่ผู้เขียนเผยแพร่ ไม่มีการแก้ไขหรือฝึกเพิ่ม ' +
  'ผู้เขียนโมเดลไม่ได้รับรองหรือสนับสนุนแอปนี้';

export const CREDITS_NOTICE_EN =
  'Models by Philip Hofmann are used under the Creative Commons Attribution 4.0 International licence. ' +
  'No changes were made to the model weights. The authors do not endorse this app.';
