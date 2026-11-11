import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { unstable_readConfig } from 'wrangler';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = join(root, 'wrangler.toml');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

test('embedding provider source has no application database or index dispatcher capability', () => {
  const forbidden = /SUPABASE_(?:URL|SERVICE_ROLE_KEY)|JOB_INDEX_COORDINATOR|JobIndexCoordinator|kickJobIndexing|\/rest\/v1\/(?:rpc|[a-z_]+)|@supabase\/|\b(?:postgres|pg|mysql2?|@neondatabase\/serverless)\b|\b(?:claim_job_index|finish_job_index_batch|reconcile_job_index)\b/i;
  for (const path of sourceFiles(join(root, 'src'))) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), forbidden, `${path} crosses the provider boundary`);
  }
});

for (const env of [undefined, 'dev', 'qa', 'staging', 'production']) {
  test(`${env ?? 'local'} provider configuration has no database or indexing dispatcher binding`, () => {
    const parsed = unstable_readConfig({ config, ...(env ? { env } : {}) }, { hideWarnings: true });
    assert.doesNotMatch(JSON.stringify(parsed.vars), /SUPABASE_(?:URL|SERVICE_ROLE_KEY)|JOB_INDEX_COORDINATOR/i);
    assert.equal(parsed.durable_objects?.bindings?.length || 0, 0);
    assert.equal(parsed.d1_databases?.length || 0, 0);
    assert.equal(parsed.hyperdrive?.length || 0, 0);
    assert.equal(parsed.triggers?.crons?.length || 0, 0);
  });
}

test('embedding provider has no database client dependency', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  for (const dependency of dependencies) {
    assert.doesNotMatch(dependency, /^(?:@supabase\/|postgres$|pg$|mysql2?$|@neondatabase\/)/i);
  }
});
