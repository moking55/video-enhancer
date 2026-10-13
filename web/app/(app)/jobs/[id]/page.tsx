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
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Job</h1>
      <Suspense
        fallback={<p className="text-zinc-600 dark:text-zinc-400">Loading...</p>}
      >
        <JobBody params={props.params} />
      </Suspense>
    </main>
  );
}
