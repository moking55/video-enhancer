import { notFound } from "next/navigation";

import { CompareViewer } from "@/components/compare/compare-viewer";

/**
 * Dev-only harness for the CompareViewer with two local sample clips in
 * `public/dev/` (generated with ffmpeg testsrc2; *.mp4 is gitignored):
 *   ffmpeg -f lavfi -i testsrc2=size=320x180:rate=30:duration=3 -c:v libx264 -pix_fmt yuv420p -g 15 -movflags +faststart public/dev/sample-input.mp4
 *   ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30:duration=3 -f lavfi -i sine=frequency=440:duration=3 -c:v libx264 -pix_fmt yuv420p -g 15 -c:a aac -shortest -movflags +faststart public/dev/sample-output.mp4
 * Returns 404 in production.
 */
export default function DevComparePage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">ตัวเปรียบเทียบวิดีโอ (dev)</h1>
      <CompareViewer
        inputUrl="/dev/sample-input.mp4"
        outputUrl="/dev/sample-output.mp4"
        fps={30}
        outputWidth={640}
        outputHeight={360}
      />
    </main>
  );
}
