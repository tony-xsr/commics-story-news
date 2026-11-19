import { ImageSource } from 'expo-image';
import { avatars } from './avatars';
import { CHAPTER_TITLES, getChapterText, TOTAL_CHAPTERS } from './mockChapterText';
import { findStory, moreStories, newReleases, popular, trending } from './mockStories';

export type Chapter = {
  /** Server chapter id (API data). */
  id?: string;
  number: number;
  title: string;
  date: string;
};

export type Comment = {
  id: string;
  /** Server user id of the author (block list filtering). */
  authorId?: string;
  name: string;
  level: number;
  avatar?: ImageSource;
  text: string;
  createdAt: string;
  likes: number;
};

export type StoryDetail = {
  id: string;
  title: string;
  author: string;
  /** Author page (null: no author record). */
  authorId?: string | null;
  authorAvatar?: ImageSource;
  /** Usual release days (0 = Sunday …) and the next scheduled chapter — story page / end of story. */
  releaseDays?: number[];
  nextChapterAt?: string | null;
  /** Language this version is written in, and the other public language versions of the work. */
  language?: string;
  translations?: { storyId: string; language: string; title: string }[];
  cover?: ImageSource;
  rating: string;
  views: string;
  about: string;
  tags: string[];
  chapters: Chapter[];
  topComments: Comment[];
};

const ABOUT =
  'A quiet summer brings two strangers together under a sky filled with stars. What begins as a simple encounter slowly turns into an unexpected connection, as they navigate friendship, love, and the uncertainty of what comes next. Every night under the same stars, they learn that some people arrive in your life exactly when you need them most.';

// Demo tags: each story shows 1-6 of its own genres followed by these.
const DEFAULT_TAGS = ['Slow Burn', 'Coming of Age', 'Slice of Life', 'Found Family', 'Second Chance', 'Enemies to Lovers'];
const MIN_TAGS = 1;
const MAX_TAGS = 6;

// Stable pseudo-random tag count per story (same story always shows the same number).
const tagCountFor = (id: string) => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  return MIN_TAGS + (hash % (MAX_TAGS - MIN_TAGS + 1));
};

const COMMENT_TEXT =
  'What begins as a simple encounter slowly turns into an unexpected connection, as they navigate friendship, love, and the uncertainty…';

const FIRST_CHAPTER_DATE = new Date(2026, 9, 3);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A new chapter every 3 days. After the 10 real titles, the titles repeat with the round number: "The Silver Ring (2)"
const chapterDate = (index: number) => {
  const date = new Date(FIRST_CHAPTER_DATE.getTime() + index * 3 * 24 * 60 * 60 * 1000);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
};

export const chapters: Chapter[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => {
  const round = Math.floor(index / CHAPTER_TITLES.length);
  const title = CHAPTER_TITLES[index % CHAPTER_TITLES.length];
  return { number: index + 1, title: round === 0 ? title : `${title} (${round + 1})`, date: chapterDate(index) };
});

export const topComments: Comment[] = [
  { id: 'tc1', name: 'reader', level: 1, avatar: avatars.demo, text: COMMENT_TEXT, createdAt: '25/10/2026 23:14', likes: 24 },
  { id: 'tc2', name: 'jackybruss', level: 1, avatar: avatars.mixmanga, text: COMMENT_TEXT, createdAt: '25/10/2026 23:14', likes: 9 },
  { id: 'tc3', name: 'ipangdz', level: 2, avatar: avatars.ipangdz, text: COMMENT_TEXT, createdAt: '26/10/2026 08:02', likes: 3 },
];

export const chapterComments: Comment[] = Array.from({ length: 3 }, (_, i) => ({
  id: `cc${i}`,
  name: 'reader',
  level: 1,
  avatar: avatars.demo,
  text: COMMENT_TEXT,
  createdAt: '25/10/2026 23:14',
  likes: 5 - i,
}));

export const CHAPTER_COMMENT_TOTAL = 16;

export const popularSearches = [...trending.slice(0, 3), ...popular.slice(3, 6)];

export { getChapterText };

export function getStoryDetail(id: string): StoryDetail | undefined {
  const story = findStory(id);
  if (!story) return undefined;

  const listEntry = moreStories.find((item) => item.id === id) ?? newReleases.find((item) => item.id === id);
  const genreTags = listEntry ? listEntry.tags : story.genres.split(' · ');
  const tags = [...genreTags, ...DEFAULT_TAGS.filter((tag) => !genreTags.includes(tag))].slice(0, tagCountFor(story.id));

  return {
    id: story.id,
    title: story.title.replace(/\.$/, ''),
    author: story.author ?? 'ninhnguyen',
    authorAvatar: avatars.noiuxna,
    cover: story.cover,
    rating: '4.7',
    views: listEntry?.views ?? '253.3K',
    about: listEntry?.description ? `${listEntry.description} ${ABOUT}` : ABOUT,
    tags,
    chapters,
    topComments,
  };
}
