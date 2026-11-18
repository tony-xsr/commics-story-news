/** Fields the picker needs (structurally matches `Announcement` from @storyzio/contracts). */
export type PickableAnnouncement = {
  id: string;
  frequency: 'once' | 'daily' | 'always';
  audience: 'all' | 'free' | 'premium';
};

/** Device-local record: announcement id → local day (YYYY-MM-DD) it was last shown. */
export type SeenAnnouncements = Record<string, string>;

/**
 * Which popup to show on app open: the first (highest priority) one this viewer is targeted by and hasn't seen
 * recently enough. `premium` = null while entitlements load — targeted announcements wait, "all" ones don't.
 * `always` ones are limited to once per app session by the caller (`shownThisSession`).
 */
export function pickAnnouncement<T extends PickableAnnouncement>(
  items: readonly T[],
  ctx: { seen: SeenAnnouncements; today: string; premium: boolean | null; shownThisSession: ReadonlySet<string> },
): T | null {
  for (const a of items) {
    if (a.audience !== 'all' && (ctx.premium === null || (a.audience === 'premium') !== ctx.premium)) continue;
    if (ctx.shownThisSession.has(a.id)) continue;
    const last = ctx.seen[a.id];
    if (a.frequency === 'once' && last) continue;
    if (a.frequency === 'daily' && last === ctx.today) continue;
    return a;
  }
  return null;
}

/** Keep the seen-map small: drop ids the server no longer lists (ended / deleted announcements). */
export function pruneSeen(seen: SeenAnnouncements, liveIds: readonly string[]): SeenAnnouncements {
  const live = new Set(liveIds);
  return Object.fromEntries(Object.entries(seen).filter(([id]) => live.has(id)));
}
