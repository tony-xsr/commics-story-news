/**
 * Universal Links (iOS) / App Links (Android): story pages of this site open the installed app
 * (apps/mobile app.config.js declares the domain; apps/mobile/src/app/+native-intent.tsx maps the paths).
 * Runtime env (server): APPLE_TEAM_ID, APP_BUNDLE_ID (default com.storyzio.app), ANDROID_CERT_SHA256 (comma-separated
 * SHA-256 fingerprints: Play App Signing key + upload / debug keys). Missing → the file answers 404 (no claim).
 */
export const LINKED_PATHS = ['/story/*', '/*/story/*'];

const bundleId = () => process.env.APP_BUNDLE_ID || 'com.storyzio.app';

export function appleAppSiteAssociation() {
  const team = process.env.APPLE_TEAM_ID;
  if (!team) return null;
  return {
    applinks: {
      details: [{ appIDs: [`${team}.${bundleId()}`], components: LINKED_PATHS.map((path) => ({ '/': path })) }],
    },
  };
}

export function assetLinks() {
  const fingerprints = (process.env.ANDROID_CERT_SHA256 ?? '')
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean);
  if (!fingerprints.length) return null;
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: bundleId(), sha256_cert_fingerprints: fingerprints },
    },
  ];
}

export const appLinksResponse = (body: unknown) =>
  body
    ? Response.json(body, { headers: { 'cache-control': 'public, max-age=3600' } })
    : new Response('Not found', { status: 404 });
