/** Admin GraphQL API helpers (used when SHOPIFY_ADMIN_TOKEN is set). */
import { config } from './config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './util.js';

const run = promisify(execFile);

const API_VERSION = '2025-10';

let cachedToken = null;

/** Static token if set, else a client-credentials token (Dev Dashboard apps, valid 24h). */
async function getToken() {
  if (config.adminToken) return config.adminToken;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch(`https://${config.store}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: config.adminClientId,
      client_secret: config.adminClientSecret,
    }),
  });
  if (!res.ok) throw new Error(`token exchange HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 86400) * 1000 };
  return cachedToken.value;
}

export const apiConfigured = () =>
  Boolean(config.adminToken || (config.adminClientId && config.adminClientSecret));

async function gql(query, variables) {
  const res = await fetch(`https://${config.store}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Admin API HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(`Admin API error: ${JSON.stringify(body.errors)}`);
  return body.data;
}

/** Delete an unpublished theme by numeric id. Returns true only if it was deleted. */
export async function deleteThemeViaApi({ themeId, themeName }) {
  const label = themeName || themeId;
  const gid = `gid://shopify/OnlineStoreTheme/${themeId}`;

  const { theme } = await gql('query($id: ID!) { theme(id: $id) { id role } }', { id: gid });
  if (!theme) {
    log(`  theme ${label} not found via API (already gone?)`);
    return false;
  }
  if (theme.role === 'MAIN') {
    log(`  ! refusing to delete "${label}" — it is the live theme`);
    return false;
  }

  const { themeDelete } = await gql(
    `mutation($id: ID!) { themeDelete(id: $id) { deletedThemeId userErrors { field message } } }`,
    { id: gid },
  );
  if (themeDelete.userErrors?.length) {
    log(`  ! API delete failed for "${label}": ${themeDelete.userErrors.map((e) => e.message).join('; ')}`);
    return false;
  }
  log(`  deleted theme ${label} via API`);
  return true;
}

/**
 * Delete a theme with the Shopify CLI, authenticated by a Theme Access password
 * (no Shopify exemption needed, unlike the Admin API). The password goes in via
 * the environment so it does not show up in the process list. Needs a CLI that
 * runs on the current Node (recent CLI versions require Node 22+).
 */
export async function deleteThemeViaCli({ themeId, themeName }) {
  const label = themeName || themeId;
  try {
    await run(
      config.shopifyCliBin,
      ['theme', 'delete', '--theme', String(themeId), '--store', `${config.store}.myshopify.com`, '--force'],
      {
        env: { ...process.env, SHOPIFY_CLI_THEME_TOKEN: config.themeAccessPassword, SHOPIFY_FLAG_FORCE: '1' },
        timeout: 120_000,
      },
    );
    log(`  deleted theme ${label} via Shopify CLI`);
    return true;
  } catch (err) {
    log(`  ! CLI delete failed for "${label}": ${(err.stderr || err.message || '').toString().trim().slice(0, 400)}`);
    return false;
  }
}
