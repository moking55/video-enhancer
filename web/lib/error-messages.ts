import { MAX_ACTIVE_JOBS } from '@/lib/contracts/jobs';
import { COMMON_LIMITS, MIB } from '@/lib/contracts/presets';

/**
 * Thai UI text for stable API / worker `error.code` values. The API keeps
 * sending English `message`s (a contract); the UI looks the code up here and
 * never shows the English message. PRESET_INCOMPATIBLE / PRESET_TOO_SLOW are
 * the generic fallbacks: where the numbers are known the UI builds a precise
 * Thai reason with `describeCompatIssueTh` (lib/preset-options.ts).
 */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // API (user-facing routes)
  UNAUTHENTICATED: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง',
  FORBIDDEN: 'บัญชีนี้ไม่มีสิทธิ์ดำเนินการนี้',
  VALIDATION: 'ข้อมูลที่ส่งไม่ถูกต้อง',
  INVALID_JSON: 'รูปแบบข้อมูลที่ส่งไม่ถูกต้อง',
  NOT_FOUND: 'ไม่พบข้อมูลที่ต้องการ',
  INVALID_STATE: 'ไม่สามารถดำเนินการนี้ได้ในสถานะปัจจุบัน',
  TOO_LARGE: `ไฟล์ใหญ่เกินขีดจำกัด (สูงสุด ${COMMON_LIMITS.maxSizeBytes / MIB} MiB)`,
  UNSUPPORTED_TYPE: 'รองรับเฉพาะไฟล์ MP4 เท่านั้น',
  UPLOAD_MISSING: 'ไม่พบไฟล์ที่อัปโหลด กรุณาอัปโหลดใหม่อีกครั้ง',
  UPLOAD_SIZE_MISMATCH: 'ขนาดไฟล์ที่อัปโหลดไม่ตรงกับที่แจ้งไว้ กรุณาอัปโหลดใหม่อีกครั้ง',
  ASSET_NOT_FOUND: 'ไม่พบวิดีโอนี้',
  ASSET_NOT_READY: 'วิดีโอยังอัปโหลดไม่เสร็จ',
  ASSET_BUSY: 'มีงานของวิดีโอนี้กำลังทำงานอยู่ กรุณายกเลิกงานก่อน',
  ASSET_MISSING: 'ไม่พบไฟล์วิดีโอต้นฉบับในที่เก็บไฟล์',
  PRESET_UNKNOWN: 'ไม่รู้จัก preset ที่เลือก',
  PRESET_INCOMPATIBLE: 'วิดีโอนี้ใช้ preset ที่เลือกไม่ได้',
  PRESET_TOO_SLOW: 'วิดีโอนี้จะใช้เวลาประมวลผลนานเกินกำหนดเมื่อใช้ preset ที่เลือก',
  TOO_MANY_ACTIVE_JOBS: `มีงานที่รอคิวหรือกำลังทำงานได้พร้อมกันไม่เกิน ${MAX_ACTIVE_JOBS} งาน กรุณารอให้งานเดิมเสร็จก่อน`,
  NOT_CANCELLABLE: 'งานนี้เสร็จสิ้นแล้ว จึงยกเลิกไม่ได้',
  NOT_REQUEUEABLE:
    'ส่งงานกลับเข้าคิวได้เฉพาะงานที่ล้มเหลว หรืองานที่ไม่มีสัญญาณจาก worker เกิน 3 นาที',
  STORAGE_DELETE_FAILED: 'ลบไฟล์ที่เก็บไว้ไม่สำเร็จ กรุณาลองอีกครั้ง',
  INTERNAL: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองอีกครั้ง',
  SERVER_MISCONFIGURED: 'ตั้งค่าเซิร์ฟเวอร์ไม่ครบ กรุณาแจ้งผู้ดูแลระบบ',

  // Worker failure codes shown in job status (INPUT_UNSUPPORTED: see jobFailureText)
  INPUT_UNSUPPORTED: 'ไฟล์วิดีโอนี้ไม่รองรับ',
  INPUT_CORRUPT: 'ไฟล์วิดีโอเสียหายหรืออ่านไม่ได้',
  GPU_OOM: 'หน่วยความจำ GPU ไม่เพียงพอสำหรับวิดีโอนี้',
  OOM: 'หน่วยความจำ GPU ไม่เพียงพอสำหรับวิดีโอนี้',
  NO_GPU: 'Colab ไม่มี GPU ให้ใช้งาน',
  CANCELLED: 'งานถูกยกเลิกแล้ว',
  OUTPUT_INVALID: 'วิดีโอผลลัพธ์ตรวจสอบไม่ผ่าน',
  OUTPUT_MISSING: 'ไม่พบไฟล์ผลลัพธ์ที่อัปโหลด',
  OUTPUT_SIZE_MISMATCH: 'ขนาดไฟล์ผลลัพธ์ไม่ตรงกับที่แจ้งไว้',
  VERIFY_FAILED: 'วิดีโอผลลัพธ์ตรวจสอบไม่ผ่าน',
  ENCODE_FAILED: 'เข้ารหัสวิดีโอไม่สำเร็จ',
  DOWNLOAD_FAILED: 'ดาวน์โหลดวิดีโอต้นฉบับไม่สำเร็จ',
  UPLOAD_FAILED: 'อัปโหลดวิดีโอผลลัพธ์ไม่สำเร็จ',
  WEIGHTS_FAILED: 'ดาวน์โหลดโมเดลไม่สำเร็จ',
  UNAVAILABLE: 'worker ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้',
  STALE_ATTEMPT: 'งานนี้ถูกส่งไปรันใหม่แล้ว ผลของรอบนี้จึงไม่ถูกใช้',
  INVALID_WORKER_TOKEN: 'worker token ไม่ถูกต้องหรือถูกเพิกถอนแล้ว',
};

/** Thai text for a code; unknown codes fall back to "เกิดข้อผิดพลาด (<code>)". */
export function errorMessageForCode(code: string): string {
  return ERROR_MESSAGES[code] ?? `เกิดข้อผิดพลาด (${code})`;
}

/**
 * Thai message for a parsed API error response (`{ error: { code } }`). When the
 * body has no code (e.g. a proxy error page) `fallback` is used.
 */
export function apiErrorText(body: unknown, fallback: string): string {
  const code = (body as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return typeof code === 'string' && code !== '' ? errorMessageForCode(code) : fallback;
}

/**
 * Thai text for a failed/cancelled job. INPUT_UNSUPPORTED keeps the worker's
 * own detail (it names the exact limit that was exceeded) after a Thai prefix;
 * known codes show the Thai message only; an unknown code keeps the detail so
 * the failure stays diagnosable.
 */
export function jobFailureText(code: string | null, detail: string | null): string {
  if (!code) return detail ? `งานล้มเหลว: ${detail}` : 'งานล้มเหลว';
  if (code === 'INPUT_UNSUPPORTED') {
    return detail ? `${ERROR_MESSAGES.INPUT_UNSUPPORTED}: ${detail}` : ERROR_MESSAGES.INPUT_UNSUPPORTED;
  }
  const text = errorMessageForCode(code);
  return code in ERROR_MESSAGES || !detail ? text : `${text}: ${detail}`;
}
