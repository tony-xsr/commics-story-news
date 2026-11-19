import { ImageSource } from 'expo-image';

export type Currency = 'coins' | 'points';

export type ShopItem = {
  id: string;
  name: string;
  image: ImageSource;
  price: number;
  currency: Currency;
  owned: boolean;
  popularity: number;
  releasedOrder: number;
  /** The pack's stickers (API); the prototype shows a sample set when absent. */
  stickers?: ImageSource[];
  /** Server ids of `stickers`, same order (sending a sticker in chat / comments). */
  stickerIds?: string[];
};

export const shopItems: ShopItem[] = [
  { id: '1', name: 'Funny Animals', image: require('../../assets/images/stickers/1.png'), price: 200, currency: 'coins', owned: false, popularity: 1, releasedOrder: 1 },
  { id: '2', name: 'Reading Life', image: require('../../assets/images/stickers/2.png'), price: 200, currency: 'coins', owned: true, popularity: 2, releasedOrder: 2 },
  { id: '3', name: 'Sticker Box', image: require('../../assets/images/stickers/3.png'), price: 200, currency: 'coins', owned: true, popularity: 3, releasedOrder: 3 },
  { id: '4', name: 'Sweet Boys', image: require('../../assets/images/stickers/4.png'), price: 200, currency: 'points', owned: false, popularity: 4, releasedOrder: 4 },
  { id: '6', name: 'Happy Girl', image: require('../../assets/images/stickers/6.png'), price: 200, currency: 'coins', owned: false, popularity: 5, releasedOrder: 6 },
  { id: '5', name: 'Cool Boys', image: require('../../assets/images/stickers/5.png'), price: 200, currency: 'points', owned: false, popularity: 6, releasedOrder: 5 },
];

export const stickerSetImages: ImageSource[] = [
  require('../../assets/images/stickers/stickerset/1.png'),
  require('../../assets/images/stickers/stickerset/2.png'),
  require('../../assets/images/stickers/stickerset/3.png'),
  require('../../assets/images/stickers/stickerset/4.png'),
  require('../../assets/images/stickers/stickerset/5.png'),
  require('../../assets/images/stickers/stickerset/6.png'),
];

export const shopTabs = ['All', 'Coins', 'Points'] as const;
export type ShopTab = (typeof shopTabs)[number];

export const sortOptions = ['Popular', 'Newest', 'Price: Low to High', 'Price: High to Low'] as const;
export type SortOption = (typeof sortOptions)[number];
