import type { ChatMessage, Conversation as ApiConversation } from '@storyzio/contracts';
import { Conversation, Message } from '../../data/mockChats';
import { t } from '../../i18n';
import { relativeTime } from '../library/mappers';

export const toMessage = (m: ChatMessage, myId: string | undefined): Message => ({
  id: m.id,
  text: m.body || (m.sticker ? t('comments.sticker') : ''),
  mine: m.senderId === myId,
  sticker: m.sticker ? { uri: m.sticker.imageUrl } : undefined,
});

export const toConversation = (c: ApiConversation, myId: string | undefined): Conversation => ({
  id: c.id,
  peerId: c.peer.id,
  name: c.peer.displayName,
  level: c.peer.level,
  avatar: c.peer.avatarUrl ? { uri: c.peer.avatarUrl } : undefined,
  timeAgo: relativeTime(c.lastMessage?.createdAt ?? c.updatedAt),
  unread: c.unread > 0,
  messages: c.lastMessage ? [toMessage(c.lastMessage, myId)] : [],
});
