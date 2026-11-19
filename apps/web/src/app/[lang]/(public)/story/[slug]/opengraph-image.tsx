import { ImageResponse } from 'next/og';
import { routeLocale, translator } from '@/i18n';
import { getStory } from '@/lib/api';
import { compactNumber, SITE_NAME } from '@/lib/site';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = SITE_NAME;
export const revalidate = 3600;

/** The cover as a data URL when the renderer can read it (PNG / JPEG); WebP covers fall back to a text-only card. */
async function coverData(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { next: { revalidate: 86_400 } });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/image\/(png|jpe?g)/.test(type)) return null;
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  } catch {
    return null;
  }
}

/** Share card for a story: cover, title, author, genres, chapters / views — generated, cached an hour. */
export default async function StoryOgImage({ params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang: raw, slug } = await params;
  const lang = routeLocale(raw);
  const t = translator(lang);
  const story = await getStory(slug, lang);
  const cover = await coverData(story?.coverUrl ?? null);
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: '#f8f5ff', padding: 56, gap: 56 }}>
        {cover ? (
          <img src={cover} width={390} height={518} style={{ borderRadius: 28, objectFit: 'cover' }} alt="" />
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: 1 }}>
          <div style={{ fontSize: 30, color: '#7d4ffe', fontWeight: 700 }}>{SITE_NAME}</div>
          <div style={{ fontSize: story && story.title.length > 30 ? 60 : 76, fontWeight: 800, color: '#1a1722', marginTop: 12, lineHeight: 1.1 }}>
            {story?.title ?? SITE_NAME}
          </div>
          {story?.author ? <div style={{ fontSize: 34, color: '#43414a', marginTop: 18 }}>{t('story.by', { author: story.author })}</div> : null}
          {story ? (
            <div style={{ display: 'flex', gap: 12, marginTop: 28, flexWrap: 'wrap' }}>
              {story.genres.slice(0, 3).map((g) => (
                <div key={g.id} style={{ fontSize: 26, color: '#7d4ffe', background: '#f1ebfa', borderRadius: 999, padding: '6px 20px' }}>
                  {g.name}
                </div>
              ))}
            </div>
          ) : null}
          {story ? (
            <div style={{ fontSize: 28, color: '#78767c', marginTop: 28 }}>
              {`${t('story.chapters', { n: story.chapterCount })} · ${t('story.views', { n: compactNumber(story.views, lang) })}`}
            </div>
          ) : null}
        </div>
      </div>
    ),
    size,
  );
}
