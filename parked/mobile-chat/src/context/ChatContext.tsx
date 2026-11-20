import { useApi, useChatUnread, useConversations, useOpenConversation } from '@storyzio/api-client';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { Conversation } from '../data/mockChats';
import { toConversation } from '../features/chat/mappers';
import { startRealtime } from '../lib/realtime';
import { useAuth } from './AuthContext';

type ChatContextValue = {
  /** Server conversations, most recent first (each with only its last message; rooms load history). */
  conversations: Conversation[];
  loaded: boolean;
  unreadCount: number;
  /** Opens (or creates) the 1-1 conversation with a user; resolves with its id. Throws the API error. */
  startConversation: (userId: string) => Promise<string>;
};

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { isSignedIn, user } = useAuth();
  const list = useConversations(isSignedIn);
  const unread = useChatUnread(isSignedIn);
  const open = useOpenConversation();

  // One socket per signed-in session, only while the app is in the foreground (pushes cover the background).
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(
    () => (active && isSignedIn && !user?.isGuest ? startRealtime(api) : undefined),
    [api, active, isSignedIn, user?.isGuest],
  );

  const { mutateAsync } = open;
  const startConversation = useCallback(async (userId: string) => (await mutateAsync(userId)).id, [mutateAsync]);
  const myId = user?.id;
  const conversations = useMemo(
    () => (list.data?.items ?? []).map((c) => toConversation(c, myId)),
    [list.data, myId],
  );

  const value = useMemo(
    () => ({ conversations, loaded: !list.isPending, unreadCount: unread.data?.count ?? 0, startConversation }),
    [conversations, list.isPending, unread.data, startConversation],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat must be used within ChatProvider');
  return context;
}
