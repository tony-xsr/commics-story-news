import { ImageSource } from 'expo-image';

export type Message = {
  id: string;
  text: string;
  mine: boolean;
  /** Sticker message (shown as an image, no bubble). */
  sticker?: ImageSource;
};

export type Conversation = {
  id: string;
  /** The other person (server user id). */
  peerId?: string;
  name: string;
  level: number;
  avatar?: ImageSource;
  timeAgo: string;
  unread: boolean;
  messages: Message[];
};
