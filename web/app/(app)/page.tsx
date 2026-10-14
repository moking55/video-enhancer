import { AssetList } from '@/components/asset-list';
import { UploadForm } from '@/components/upload-form';

/**
 * No request-time data here: both client components fetch after hydration, so
 * the page shell prerenders under cacheComponents (auth is gated by the layout).
 */
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">ปรับปรุงคุณภาพวิดีโอ</h1>
      <section aria-labelledby="upload-heading" className="flex flex-col gap-3">
        <h2 id="upload-heading" className="text-xl font-semibold">
          อัปโหลดและปรับปรุงคุณภาพ
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          เลือกไฟล์ MP4 และ preset แล้วกด &quot;อัปโหลดและเริ่มประมวลผล&quot; ระบบจะอัปโหลดวิดีโอและเพิ่มเข้าคิวให้ในขั้นตอนเดียว
          จากนั้นเปิด Colab notebook เพื่อให้ประมวลผลงานในคิว
        </p>
        <UploadForm />
      </section>
      <AssetList />
    </main>
  );
}
