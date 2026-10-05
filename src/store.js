/** Append-only JSON store for the selector records. */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { config } from './config.js';
import { log } from './util.js';

async function readAll(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // An empty (or whitespace-only) file is the same as "nothing captured yet" —
  // a touched file, or a run killed before the first atomic write landed.
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(
      `${file} exists but is not valid JSON: ${err.message}. ` +
        `Move it aside (or delete it) and re-run to start a fresh file.`,
    );
  }
}

/**
 * Append (or replace, when the themeId already exists) one record.
 * Written atomically so an interrupted run can't truncate the file.
 *
 * Record shape:
 * {
 *   themeId, themeName, price, url,
 *   selectors: {
 *     orderLevelGift:   { cartSelector, cartDrawerSelector },
 *     productLevelGift: { cartSelector, cartDrawerSelector }
 *   }
 * }
 */
export async function appendRecord(record, file = config.outputFile) {
  const all = await readAll(file);
  const idx = all.findIndex((r) => String(r.themeId) === String(record.themeId));
  if (idx >= 0) all[idx] = record;
  else all.push(record);

  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  log(`  saved record for ${record.themeName} (${all.length} total)`);
  return all.length;
}

/** themeIds already captured, so re-runs can skip them. */
export async function existingThemeUrls(file = config.outputFile) {
  const all = await readAll(file);
  return new Set(all.map((r) => r.url).filter(Boolean));
}
