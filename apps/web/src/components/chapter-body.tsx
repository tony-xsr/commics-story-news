'use client';

import type { ChapterContent } from '@storyzio/contracts';
import { useI18n } from '@/i18n/client';

/** A chapter's text or comic pages (server-rendered for free chapters, client-rendered for paid ones). */
export function ChapterBody({ content }: { content: ChapterContent }) {
  const { t } = useI18n();
  if (content.kind === 'images') {
    return (
      <div className="-mx-4 grid sm:mx-0">
        {(content.pages ?? []).map((p, i) => (
          <div key={p.url} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- comic pages: intrinsic size from the API, lazy below the fold */}
            <img src={p.url} width={p.width} height={p.height} alt={t('chapter.page', { n: i + 1 })} loading={i < 2 ? 'eager' : 'lazy'} className="h-auto w-full" />
            {content.watermark ? <PageWatermark code={content.watermark} /> : null}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-5 font-serif text-lg leading-8 text-text-primary">
      {(content.body ?? '')
        .split(/\n+/)
        .filter((p) => p.trim())
        .map((p, i) => (
          <p key={i}>{p}</p>
        ))}
    </div>
  );
}

/** The reader's code tiled faintly over a paid page (admin switch): screenshots of the page stay traceable. */
function PageWatermark({ code }: { code: string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex select-none flex-col justify-around overflow-hidden">
      {Array.from({ length: 6 }, (_, i) => (
        <p
          key={i}
          className="whitespace-nowrap text-[11px] tracking-wider"
          style={{ color: 'rgba(127,127,127,0.18)', transform: 'rotate(-24deg)', marginLeft: i % 2 ? '-10%' : '-30%' }}
        >
          {`${code}   ${code}   ${code}   ${code}`}
        </p>
      ))}
    </div>
  );
}
