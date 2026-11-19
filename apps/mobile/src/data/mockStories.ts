import { ImageSource } from 'expo-image';
import { covers } from './covers';
import { GenreId } from './genres';

export type Story = {
  id: string;
  title: string;
  genres: string;
  genreIds: GenreId[];
  cover?: ImageSource;
  author?: string;
  /** Set by the API mappers (the mock data uses badgeFor(id)). */
  badge?: 'new' | 'hot';
  /** Rated 18+: “18+” on the cover, age confirmation before opening. */
  adult?: boolean;
};

export type StoryListEntry = Omit<Story, 'genres'> & {
  tags: string[];
  description: string;
  views: string;
  chapters: number;
};

export const popular: Story[] = [
  { id: 'p1', cover: covers.cannotReachYou, title: 'The Boy Next Free Door.', genres: 'Romance · Drama', genreIds: ['romance', 'drama', 'lgbtq', 'school-life'] },
  { id: 'p2', cover: covers.kissBeyondTheStars, title: 'A Kiss Beyond the Stars.', genres: 'Fantasy Romance', genreIds: ['fantasy', 'romance'] },
  { id: 'p3', cover: covers.claimedByTheBillionaireCeo, title: "The Billionaire's Secret.", genres: 'Billionaire', genreIds: ['romance', 'drama'] },
  { id: 'p4', cover: covers.bloodOverBrightHaven, title: 'Blood Over Bright Haven', genres: 'Fantasy Romance', genreIds: ['fantasy', 'mystery', 'supernatural'] },
  { id: 'p5', cover: covers.moonlitGarden, title: 'Moonlit Garden', genres: 'Isekai · Fantasy', genreIds: ['isekai', 'fantasy', 'romance', 'drama'] },
  { id: 'p6', cover: covers.theFoxAndTheMoon, title: 'The Fox and the Moon', genres: 'Billionaire Romane', genreIds: ['fantasy', 'supernatural', 'romance'] },
];

export const trending: Story[] = [
  { id: 't1', cover: covers.sasakiAndMiyanoJp, title: 'Under the Same Stars.', genres: 'LGBTQ+ · Slow Burn', genreIds: ['lgbtq', 'romance', 'school-life'] },
  { id: 't2', cover: covers.theCrimsonCrown, title: 'Married to the Enemy.', genres: 'Historical Romance', genreIds: ['historical', 'romance', 'drama'] },
  { id: 't3', cover: covers.sasakiAndMiyano, title: 'Our Summer in June.', genres: 'School Romance', genreIds: ['lgbtq', 'school-life', 'romance', 'comedy'] },
  { id: 't4', cover: covers.aPlaceCalledHome, title: 'A Place Called Home', genres: 'LGBT · Slow Burn', genreIds: ['lgbtq', 'drama', 'supernatural'] },
  { id: 't5', cover: covers.waves, title: 'The Last Waves', genres: 'Drama · Historical', genreIds: ['drama', 'historical', 'mystery'] },
  { id: 't6', cover: covers.theNewKidInSchool, title: 'The Little Witch', genres: 'School Romance', genreIds: ['school-life', 'romance', 'comedy'] },
];

export const novelPicks: Story[] = [
  { id: 'n1', cover: covers.whatTheWoodsTook, title: 'Under the Same Stars.', genres: 'Drama · Mystery', genreIds: ['drama', 'mystery', 'supernatural'] },
  { id: 'n2', cover: covers.weAllLoveTheBeautifulGirls, title: 'Married to the Enemy.', genres: 'Historical Romance', genreIds: ['lgbtq', 'drama', 'romance'] },
  { id: 'n3', cover: covers.theWayOfTheNameless, title: 'Our Summer in June.', genres: 'Isekai · Cultivation', genreIds: ['isekai', 'fantasy', 'cultivation', 'drama'] },
];

export const comicPicks: Story[] = [
  { id: 'c1', cover: covers.onePiece, title: 'Under the Same Stars.', genres: 'LGBT · Slow Burn', genreIds: ['action', 'comedy', 'fantasy', 'isekai'] },
  { id: 'c2', cover: covers.jujutsuKaisen, title: 'Married to the Enemy.', genres: 'Historical Romance', genreIds: ['action', 'supernatural', 'fantasy', 'cultivation'] },
  { id: 'c3', cover: covers.attackOnTitan, title: 'Our Summer in June.', genres: 'School Romance', genreIds: ['action', 'drama', 'mystery'] },
];

export const newReleases: StoryListEntry[] = [
  {
    id: 'nr1',
    cover: covers.onePiece,
    title: 'One Piece',
    tags: ['Romance', 'Drama'],
    genreIds: ['action', 'comedy', 'fantasy'],
    description: 'Monkey D. Luffy sets sail with his crew to find the legendary treasure and become the King of the Pirates.',
    views: '1.5M',
    chapters: 153,
  },
  {
    id: 'nr2',
    cover: covers.theCrimsonCrown,
    title: 'The Kingdom Beyond the Forgotten Crown',
    tags: ['Historical Romance'],
    genreIds: ['historical', 'romance', 'drama'],
    description: 'A banished heir returns to reclaim a throne no one believes she deserves.',
    views: '892.1K',
    chapters: 87,
  },
  {
    id: 'nr3',
    cover: covers.jujutsuKaisen,
    title: 'Jujutsu Kaisen',
    tags: ['Action', 'Supernatural'],
    genreIds: ['action', 'supernatural'],
    description: 'A high school student swallows a cursed object and is pulled into a hidden world of sorcerers.',
    views: '2.1M',
    chapters: 236,
  },
  {
    id: 'nr4',
    cover: covers.weAllLoveTheBeautifulGirls,
    title: 'We All Love the Beautiful Girls Next Door',
    tags: ['Drama', 'Romance'],
    genreIds: ['lgbtq', 'drama', 'romance'],
    description: 'Married to the Enemy: a historical romance of two rival houses forced together.',
    views: '345.2K',
    chapters: 64,
  },
  {
    id: 'nr5',
    cover: covers.attackOnTitan,
    title: 'Attack on Titan',
    tags: ['Action', 'Drama', 'Mystery'],
    genreIds: ['action', 'drama', 'mystery'],
    description: 'Humanity fights for survival behind walls built to keep out giant man-eating Titans.',
    views: '3.4M',
    chapters: 139,
  },
  {
    id: 'nr6',
    cover: covers.theWayOfTheNameless,
    title: 'The Way of the Nameless Cultivator',
    tags: ['Fantasy', 'Isekai'],
    genreIds: ['fantasy', 'isekai', 'cultivation'],
    description: 'A nameless cultivator rises through hidden sects on the way to immortality.',
    views: '112.7K',
    chapters: 41,
  },
];

export const moreStories: StoryListEntry[] = [
  {
    id: 'm1',
    cover: covers.onePiece,
    title: 'One Piece',
    tags: ['Romance'],
    genreIds: ['action', 'comedy', 'fantasy'],
    description: 'Monkey D. Luffy sets sail with his crew to find the legendary treasure and become the King of the Pirates.',
    views: '1.5M',
    chapters: 153,
  },
  {
    id: 'm2',
    cover: covers.jujutsuKaisen,
    title: 'The Greatest Estate Developer',
    tags: ['Romance', 'Drama'],
    genreIds: ['action', 'supernatural'],
    description: 'Monkey D. Luffy sets sail with his crew to find the legendary treasure and become the King of the Pirates.',
    views: '234.63K',
    chapters: 59,
  },
  {
    id: 'm3',
    cover: covers.theCrimsonCrown,
    title: 'One Piece',
    tags: ['Romance', 'Drama', 'Fantasy'],
    genreIds: ['historical', 'romance'],
    description: 'Monkey D. Luffy sets sail with his crew to find the legendary treasure and become the King of the Pirates.',
    views: '1.5M',
    chapters: 153,
  },
  {
    id: 'm4',
    cover: covers.attackOnTitan,
    title: 'One Piece',
    tags: ['Action', 'Comedy', 'Isekai', 'Fantasy'],
    genreIds: ['action', 'drama'],
    description: 'Monkey D. Luffy sets sail with his crew to find the legendary treasure and become the King of the Pirates.',
    views: '1.5M',
    chapters: 153,
  },
  {
    id: 'm5',
    cover: covers.jujutsuKaisen,
    title: 'Jujutsu Kaisen',
    tags: ['Action', 'Supernatural'],
    genreIds: ['action', 'supernatural'],
    description:
      'Yuji Itadori is a high school student with extraordinary physical strength who swallows a cursed object to protect his friends, and is pulled into a hidden world of sorcerers where every fight could cost him his life.',
    views: '2.1M',
    chapters: 236,
  },
];

const COMIC_IDS = new Set(['c1', 'c2', 'c3', 'nr1', 'nr3', 'nr5', 'm1', 'm4', 'm5', 'x1']);
export const isComicStory = (id: string) => COMIC_IDS.has(id);

const allStories: Story[] = [...popular, ...trending, ...novelPicks, ...comicPicks];

export const getStoriesByGenre = (genreId: GenreId) =>
  allStories.filter((story) => story.genreIds.includes(genreId));

const authors: Record<string, string> = {
  p1: 'Mika', p2: 'Elara Voss', p3: 'Damien Cole', p4: 'Susan Palmer', p5: 'Luna Park', p6: 'Hana Seo',
  t1: 'Shou Harusono', t2: 'Isabelle Hart', t3: 'Shou Harusono', t4: 'Mira Sol', t5: 'Tim Probert', t6: 'Ren Akiyama',
  n1: 'Ava Morgan', n2: 'Clara Nguyen', n3: 'Graham Douglass',
  c1: 'Eiichiro Oda', c2: 'Gege Akutami', c3: 'Hajime Isayama',
  nr1: 'Eiichiro Oda', nr2: 'Isabelle Hart', nr3: 'Gege Akutami', nr4: 'Clara Nguyen', nr5: 'Hajime Isayama', nr6: 'Graham Douglass',
  x1: 'Chugong', m1: 'Eiichiro Oda', m2: 'Kim Narae', m3: 'Isabelle Hart', m4: 'Hajime Isayama', m5: 'Gege Akutami',
};

const libraryOnlyStory: Story = {
  id: 'x1',
  title: 'Solo Leveling',
  cover: covers.attackOnTitan,
  genres: 'Action · Fantasy',
  genreIds: ['action', 'fantasy', 'supernatural'],
};

export const searchPool: Story[] = [
  libraryOnlyStory,
  ...popular,
  ...trending,
  ...novelPicks,
  ...comicPicks,
  ...moreStories.map(({ id, title, cover, genreIds, tags }) => ({
    id,
    title,
    cover,
    genreIds,
    genres: tags.join(' · '),
  })),
].map((story) => ({ ...story, author: authors[story.id] }));

// New Releases are not in the search list (they would repeat other stories there), but every story must open a detail page
const newReleaseStories: Story[] = newReleases.map(({ id, title, cover, genreIds, tags }) => ({
  id,
  title,
  cover,
  genreIds,
  genres: tags.join(' · '),
  author: authors[id],
}));

/** A story by id from any list on the app: search list plus New Releases. */
export const findStory = (id: string): Story | undefined =>
  searchPool.find((story) => story.id === id) ?? newReleaseStories.find((story) => story.id === id);
