/**
 * Country availability of a story (licensing): `null` = everywhere; `allow` = only these ISO 3166-1 alpha-2 codes;
 * `block` = everywhere except these. Shared by the API (enforcement) and the apps / web (hiding cards in lists).
 */
export type StoryRegions = { mode: 'allow' | 'block'; countries: string[] } | null;

/**
 * `country` null = unknown (no Cloudflare header, no GeoIP match, local dev).
 * `unknown`: 'allow' gives the benefit of the doubt (story metadata, lists); 'deny' is for content in allow-lists.
 */
export function storyAvailable(
  regions: StoryRegions | undefined,
  country: string | null,
  unknown: 'allow' | 'deny' = 'allow',
): boolean {
  if (!regions || regions.countries.length === 0) return true;
  if (!country) return regions.mode === 'block' ? true : unknown === 'allow';
  const listed = regions.countries.includes(country.toUpperCase());
  return regions.mode === 'allow' ? listed : !listed;
}
