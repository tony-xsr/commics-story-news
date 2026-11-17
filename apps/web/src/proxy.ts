import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_LOCALE, isLocale } from './i18n/locales';

/**
 * Locale routing: English pages live at unprefixed URLs (`/story/x`) and are rewritten to `app/[lang]` as `en`;
 * other languages are prefixed (`/vi/story/x`). `/en/...` redirects to the unprefixed URL so each page has one
 * canonical address. API / BFF routes, files and Next internals are skipped (see `config.matcher`).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const first = pathname.split('/')[1] ?? '';
  // Generated images (og:image) are linked with the /en prefix by Next's metadata files: serve them, don't redirect.
  if (first === DEFAULT_LOCALE && pathname.includes('/opengraph-image')) return NextResponse.next();
  if (first === DEFAULT_LOCALE) {
    const rest = pathname.slice(DEFAULT_LOCALE.length + 1) || '/';
    return NextResponse.redirect(new URL(`${rest}${search}`, request.url), 308);
  }
  if (isLocale(first)) return NextResponse.next();
  return NextResponse.rewrite(new URL(`/${DEFAULT_LOCALE}${pathname === '/' ? '' : pathname}${search}`, request.url));
}

export const config = {
  // Everything except API/BFF routes, Next internals and files with an extension (sitemap.xml, robots.txt, images…).
  // `icon` / `apple-icon` are generated app icons (app/icon.tsx) without a file extension.
  matcher: ['/((?!api/|v1/|_next/|icon$|apple-icon$|.*\\..*).*)'],
};
