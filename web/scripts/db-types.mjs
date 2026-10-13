// Generates lib/supabase/database.types.ts from the Supabase dev project.
// Usage: SUPABASE_PROJECT_ID=<ref> pnpm db:types   (requires `supabase login` once)
// The project ref is not a secret; it is only read from the environment here.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectId = process.env.SUPABASE_PROJECT_ID?.trim();
if (!projectId) {
  console.error(
    'db:types: SUPABASE_PROJECT_ID is not set. Export the dev project ref first, ' +
      'e.g. SUPABASE_PROJECT_ID=<ref> pnpm db:types (see root .env.example).',
  );
  process.exit(1);
}
// Supabase refs are short alphanumeric ids. Validate because the Windows path
// below runs through a shell.
if (!/^[a-z0-9]+$/i.test(projectId)) {
  console.error('db:types: SUPABASE_PROJECT_ID must be alphanumeric (a Supabase project ref).');
  process.exit(1);
}

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(webDir, 'lib', 'supabase', 'database.types.ts');
const isWin = process.platform === 'win32';

const result = spawnSync(
  isWin ? 'npx.cmd' : 'npx',
  ['-y', 'supabase', 'gen', 'types', 'typescript', '--project-id', projectId, '--schema', 'public'],
  {
    cwd: webDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: isWin,
    maxBuffer: 16 * 1024 * 1024,
  },
);

if (result.error) {
  console.error(`db:types: failed to run npx supabase: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`db:types: supabase gen types exited with code ${result.status}; file not written.`);
  process.exit(result.status ?? 1);
}
if (!result.stdout.trim()) {
  console.error('db:types: supabase gen types produced no output; file not written.');
  process.exit(1);
}

writeFileSync(outFile, result.stdout);
console.log(`db:types: wrote ${path.relative(webDir, outFile)} from project ${projectId}.`);
