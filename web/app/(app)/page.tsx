import { AssetList } from '@/components/asset-list';
import { UploadForm } from '@/components/upload-form';

/**
 * No request-time data here: both client components fetch after hydration, so
 * the page shell prerenders under cacheComponents (auth is gated by the layout).
 */
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Enhance a video</h1>
      <section aria-labelledby="upload-heading" className="flex flex-col gap-3">
        <h2 id="upload-heading" className="text-xl font-semibold">
          Upload and enhance
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Pick an MP4 and a preset, then press Upload &amp; enhance. The video is uploaded and
          queued in one step; open the Colab notebook to process the queue.
        </p>
        <UploadForm />
      </section>
      <AssetList />
    </main>
  );
}
