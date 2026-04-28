import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPOOL_DIR = path.join(__dirname, '.phronesis-spool');

function spoolDir(dir = process.env.PHRONESIS_SPOOL_DIR || DEFAULT_SPOOL_DIR) {
  return dir;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function enqueuePhronesisPayload(payload, options = {}) {
  const dir = spoolDir(options.spoolDir);
  await ensureDir(dir);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const file = path.join(dir, `${id}.json`);
  const record = {
    id,
    createdAt: new Date().toISOString(),
    status: 'queued',
    payload,
  };
  await fs.writeFile(file, JSON.stringify(record, null, 2));
  return { queued: true, spool: file, id };
}

export async function listSpoolEntries(options = {}) {
  const dir = spoolDir(options.spoolDir);
  await ensureDir(dir);
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  return names.map((name) => path.join(dir, name));
}

export async function flushPhronesisSpool(mediation, options = {}) {
  const entries = await listSpoolEntries(options);
  const results = [];

  for (const file of entries) {
    const raw = await fs.readFile(file, 'utf8');
    const record = JSON.parse(raw);
    try {
      const response = await mediation.ingestTurnSummary(record.payload);
      let merge = null;
      const approved = Array.isArray(response?.candidates)
        ? response.candidates.filter((candidate) => candidate?.review_state === 'approved')
        : [];

      if (approved.length > 0 && typeof mediation.proposePatch === 'function') {
        merge = await mediation.proposePatch({
          decisions: approved.map((candidate) => ({
            candidate_id: candidate.candidate_id,
            decision: 'approved',
          })),
        });
      }

      await fs.unlink(file);
      results.push({ file, ok: true, response, merge });
    } catch (error) {
      results.push({ file, ok: false, error: String(error?.message || error) });
    }
  }

  return {
    processed: results.length,
    success: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
