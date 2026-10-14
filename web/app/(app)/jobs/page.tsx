import { JobList } from "@/components/job-list";

/** No request-time data here: JobList fetches after hydration (auth is gated by the layout). */
export default function JobsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">งาน</h1>
      <JobList />
    </main>
  );
}
