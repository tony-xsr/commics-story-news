import { getSeoSettings, getStory } from './api';
import { absolute, contentAlternates, SITE_NOINDEX } from './seo';
import { SITE_URL, storyPath } from './site';

/** IndexNow key (8–128 chars [a-zA-Z0-9-]); served at /indexnow-key.txt. Empty = off. */
export const INDEXNOW_KEY = /^[\w-]{8,128}$/.test(process.env.INDEXNOW_KEY ?? '') ? process.env.INDEXNOW_KEY! : '';

/**
 * Tells IndexNow engines (Bing, Yandex, Naver, Seznam…) that these stories changed, right after an admin edit /
 * chapter release (called from /api/revalidate). Google ignores IndexNow; it reads the sitemap.
 */
export async function pingIndexNow(slugs: string[]): Promise<void> {
  if (!INDEXNOW_KEY || SITE_NOINDEX || !slugs.length) return;
  if (!(await getSeoSettings())?.indexNow) return;
  const urls: string[] = [];
  for (const slug of slugs.slice(0, 100)) {
    const story = await getStory(slug);
    if (story && story.ageRating < 18 && !story.seo.noindex) urls.push(absolute(contentAlternates(story, storyPath(story.slug)).canonical));
  }
  if (!urls.length) return;
  await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(SITE_URL).host,
      key: INDEXNOW_KEY,
      keyLocation: `${SITE_URL}/indexnow-key.txt`,
      urlList: urls,
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
}
