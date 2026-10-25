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

/**
 * Selectors you already know for a theme, from preselected.json. When a theme
 * has an entry, the selector algorithm is skipped and these are used as-is.
 *
 * The file is an object keyed by theme URL (as in shopify_themes.json); the
 * theme name or "handle/preset" also work as keys. Each value is:
 *   {
 *     "orderLevelGift":   { "cartSelector": "...", "cartDrawerSelector": "..." },
 *     "productLevelGift": { "cartSelector": "...", "cartDrawerSelector": "..." }
 *   }
 * A full record from theme-selectors.json (with a `selectors` field) works too.
 *
 * @returns {Promise<object|null>} the selectors, or null when there is no entry
 */
export async function findPreselected(theme, file = config.preselectedFile) {
  let data;
  try {
    data = JSON.parse((await readFile(file, 'utf8')) || '{}');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  const keys = [theme.url, `${theme.handle}/${theme.preset}`, theme.name].filter(Boolean);
  for (const key of keys) {
    const entry = data[key];
    if (!entry) continue;
    const sel = entry.selectors || entry;
    const pick = (k) => ({
      cartSelector: sel[k]?.cartSelector || '',
      cartDrawerSelector: sel[k]?.cartDrawerSelector || '',
    });
    return { orderLevelGift: pick('orderLevelGift'), productLevelGift: pick('productLevelGift') };
  }
  return null;
}
