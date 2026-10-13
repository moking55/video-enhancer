import { AssetList } from '@/components/asset-list';
import { UploadForm } from '@/components/upload-form';

/**
 * No request-time data here: both client components fetch after hydration, so
 * the page shell prerenders under cacheComponents (auth is gated by the layout).
 */
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Video Enhancer</h1>
      <section aria-labelledby="upload-heading" className="flex flex-col gap-3">
        <h2 id="upload-heading" className="text-xl font-semibold">
          Upload a video
        </h2>
        <UploadForm />
      </section>
      <AssetList />
    </main>
  );
}
