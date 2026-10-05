/** Screenshot capture + the (stubbed) Google Docs publishing hook. */
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log, slugify } from './util.js';

/**
 * Save a snapshot of the current page. When `rootSelector` is given and the
 * element is on screen, the viewport shot is used so the drawer is captured in
 * context (an element-only shot of a fixed drawer is often clipped).
 *
 * A second copy lands in `<snapshotDir>/all/` as
 * `<theme-name>_<theme-id>_<label>.png`, so every shot from every theme is
 * available in one flat folder.
 *
 * @returns {Promise<string>} absolute path to the PNG
 */
export async function captureSnapshot(page, { themeName, themeId, label, rootSelector = null }) {
  const dir = path.join(config.snapshotDir, slugify(themeName));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slugify(label)}.png`);

  if (rootSelector) {
    await page.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: true });
  }

  const allDir = path.join(config.snapshotDir, 'all');
  await mkdir(allDir, { recursive: true });
  await copyFile(file, path.join(allDir, `${slugify(themeName)}_${themeId}_${slugify(label)}.png`));

  log(`  snapshot -> ${path.relative(process.cwd(), file)}`);
  return file;
}

/**
 * Publish the captured snapshots to a Google Doc.
 *
 * NOT IMPLEMENTED — deliberately left as a hook. Wiring it up needs:
 *   1. `npm i googleapis`
 *   2. A service account JSON (GOOGLE_APPLICATION_CREDENTIALS) with the
 *      Drive + Docs APIs enabled, and a Drive folder shared with that account.
 *   3. Upload each PNG to Drive (Docs API cannot read local files), then
 *      batchUpdate the Doc with insertText + insertInlineImage requests
 *      pointing at the uploaded file's webContentLink.
 *
 * Until then this logs the files it would have published and returns null, so
 * the pipeline keeps running.
 *
 * @param {{themeName: string, themeId: string, snapshots: Record<string, string|null>}} record
 * @returns {Promise<string|null>} the Doc URL once implemented
 */
export async function publishToGoogleDocs(record) {
  const files = Object.entries(record.snapshots).filter(([, v]) => v);
  if (!files.length) return null;
  log(`  [google-docs] pending publish for ${record.themeName}: ${files.map(([k]) => k).join(', ')}`);
  return null;
}
