// Demo numbers behind the NEW / HOT labels on covers. A real backend would send these per story.
export type StoryBadge = 'new' | 'hot';

type Stats = {
  /** Reads, to rank the stories. */
  views: number;
  /** Days since the story came out (or got its latest chapter). */
  daysAgo: number;
};

const STATS: Record<string, Stats> = {
  p1: { views: 1_900_000, daysAgo: 120 },
  p2: { views: 640_000, daysAgo: 40 },
  p3: { views: 1_500_000, daysAgo: 90 },
  p4: { views: 720_000, daysAgo: 75 },
  p5: { views: 480_000, daysAgo: 60 },
  p6: { views: 390_000, daysAgo: 33 },
  t1: { views: 830_000, daysAgo: 48 },
  t2: { views: 910_000, daysAgo: 52 },
  t3: { views: 560_000, daysAgo: 66 },
  t4: { views: 210_000, daysAgo: 3 },
  t5: { views: 1_700_000, daysAgo: 25 },
  t6: { views: 340_000, daysAgo: 38 },
  n1: { views: 450_000, daysAgo: 80 },
  n2: { views: 160_000, daysAgo: 5 },
  n3: { views: 270_000, daysAgo: 44 },
  c1: { views: 1_600_000, daysAgo: 200 },
  c2: { views: 880_000, daysAgo: 150 },
  c3: { views: 760_000, daysAgo: 170 },
  m1: { views: 590_000, daysAgo: 100 },
  m2: { views: 310_000, daysAgo: 60 },
  m3: { views: 250_000, daysAgo: 85 },
  m4: { views: 420_000, daysAgo: 95 },
  m5: { views: 1_400_000, daysAgo: 110 },
  nr1: { views: 1_500_000, daysAgo: 28 },
  nr2: { views: 90_000, daysAgo: 7 },
  nr3: { views: 520_000, daysAgo: 21 },
  nr4: { views: 70_000, daysAgo: 10 },
  nr5: { views: 680_000, daysAgo: 30 },
  nr6: { views: 55_000, daysAgo: 12 },
  x1: { views: 980_000, daysAgo: 140 },
};

// The most read stories are HOT; stories that came out recently are NEW
const HOT_COUNT = 6;
const NEW_WITHIN_DAYS = 14;

const hotIds = new Set(
  Object.entries(STATS)
    .sort(([, a], [, b]) => b.views - a.views)
    .slice(0, HOT_COUNT)
    .map(([id]) => id),
);

/**
 * The label a story gets on its cover: one at most. A story that is both HOT and NEW shows `prefer`
 * (HOT in general; the New Releases section passes 'new').
 */
export function badgeFor(id: string, prefer: StoryBadge = 'hot'): StoryBadge | undefined {
  const hot = hotIds.has(id);
  const fresh = (STATS[id]?.daysAgo ?? Infinity) <= NEW_WITHIN_DAYS;
  if (hot && fresh) return prefer;
  return hot ? 'hot' : fresh ? 'new' : undefined;
}
