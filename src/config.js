import 'dotenv/config';
import path from 'node:path';

const root = process.cwd();
const abs = (p) => (path.isAbsolute(p) ? p : path.join(root, p));

const store = process.env.SHOPIFY_STORE;
if (!store) {
  throw new Error('SHOPIFY_STORE is not set. Copy .env.example to .env and fill it in.');
}

export const config = {
  store,
  storeUrl: (process.env.STORE_URL || `https://${store}.myshopify.com`).replace(/\/$/, ''),
  adminUrl: (process.env.ADMIN_URL || `https://admin.shopify.com/store/${store}`).replace(/\/$/, ''),
  // Optional Admin API token (custom app, read_themes + write_themes). When set,
  // themes are deleted via the API instead of the admin UI.
  adminToken: process.env.SHOPIFY_ADMIN_TOKEN || '',
  // Dev Dashboard app credentials, exchanged for a 24h token when no static token is set.
  adminClientId: process.env.SHOPIFY_CLIENT_ID || '',
  adminClientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
  // Theme Access password (shptka_...) used by the Shopify CLI to delete themes.
  themeAccessPassword: process.env.SHOPIFY_THEME_ACCESS_PASSWORD || '',
  // Directory of a Node >= 22 to run the CLI with when this process is on an older Node.
  shopifyCliNodeBin: process.env.SHOPIFY_CLI_NODE_BIN || '',
  shopifyCliBin: process.env.SHOPIFY_CLI_BIN || 'shopify',
  themeStoreUrl: 'https://themes.shopify.com',

  productPaths: (process.env.PRODUCT_PATHS ||
    '/products/the-complete-snowboard,/products/the-multi-location-snowboard')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Product added as the gift line alongside each primary product, then removed.
  giftProductHandle: process.env.GIFT_PRODUCT_HANDLE || 'the-collection-snowboard-oxygen',

  authState: abs(process.env.AUTH_STATE || './auth.json'),
  // On-disk Chrome profile shared by `npm run login` and `npm run start`. This
  // is what makes the login survive between runs; deleting it forces a re-login.
  userDataDir: abs(process.env.USER_DATA_DIR || './.browser-profile'),
  // Installed Chrome by default — bundled Chromium trips Shopify's bot checks
  // more often. Set BROWSER_CHANNEL= (empty) to force bundled Chromium.
  browserChannel: process.env.BROWSER_CHANNEL ?? 'chrome',
  themesFile: abs(process.env.THEMES_FILE || './shopify_themes.json'),
  outputFile: abs(process.env.OUTPUT_FILE || './theme-selectors.json'),
  // Known-good selectors per theme; matching themes skip the selector algorithm.
  preselectedFile: abs(process.env.PRESELECTED_FILE || './preselected.json'),
  snapshotDir: abs(process.env.SNAPSHOT_DIR || './snapshots'),

  headed: process.env.HEADED !== '0',
  installTimeout: Number(process.env.INSTALL_TIMEOUT || 180000),
};

/** Parse `--flag value` / `--flag=value` / `--flag` from argv. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}
