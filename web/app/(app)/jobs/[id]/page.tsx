import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { JobDetail } from "@/components/job-detail";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `params` is a Promise and is runtime data here, so it is awaited inside <Suspense>. */
async function JobBody({ params }: { params: PageProps<"/jobs/[id]">["params"] }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <JobDetail jobId={id} />;
}

export default function JobPage(props: PageProps<"/jobs/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <Link
        href="/jobs"
        className="w-fit rounded-md text-sm underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        ← Back to jobs
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Job</h1>
      <Suspense
        fallback={<p className="text-zinc-600 dark:text-zinc-400">Loading...</p>}
      >
        <JobBody params={props.params} />
      </Suspense>
    </main>
  );
}
