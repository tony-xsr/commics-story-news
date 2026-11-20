import { qk, type Endpoints } from '@storyzio/api-client';
import { CHAT_SOCKET_EVENT, type ChatEvent, type ChatMessage, type MessagePage } from '@storyzio/contracts';
import type { InfiniteData } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { queryClient, tokenStore } from './api';
import { REALTIME_URL } from './config';

/**
 * Chat events over Socket.IO (realtime process). The socket only RECEIVES; sending goes through REST so it can be
 * retried. Each (re)connect reads the current access token; an expired token is refreshed by any API call.
 */
export function startRealtime(api: Endpoints): () => void {
  const socket: Socket = io(REALTIME_URL, {
    path: '/realtime',
    transports: ['websocket'],
    auth: (cb) => {
      void Promise.resolve(tokenStore.get()).then((t) => cb({ token: t?.accessToken ?? '' }));
    },
    reconnectionDelayMax: 30_000,
  });

  socket.on('connect_error', (err) => {
    if (err.message !== 'UNAUTHENTICATED') return;
    // Access tokens live 15 min: one API call refreshes it, then reconnect with the new one.
    void api.auth
      .me()
      .then(() => socket.connect())
      .catch(() => undefined);
  });
  // Missed events while offline: refetch what is on screen.
  socket.on('connect', () => void queryClient.invalidateQueries({ queryKey: ['chat'] }));
  socket.on(CHAT_SOCKET_EVENT, (event: ChatEvent) => apply(event));

  return () => {
    socket.removeAllListeners();
    socket.disconnect();
  };
}

/** Adds a message to its conversation's loaded history (no-op when not loaded or already there). */
export function addMessage(message: ChatMessage) {
  queryClient.setQueryData<InfiniteData<MessagePage, string | undefined>>(qk.messages(message.conversationId), (old) => {
    if (!old?.pages[0]) return old;
    if (old.pages.some((p) => p.items.some((m) => m.id === message.id))) return old;
    const [first, ...rest] = old.pages;
    return { ...old, pages: [{ ...first, items: [message, ...first.items] }, ...rest] };
  });
}

function apply(event: ChatEvent) {
  if (event.type === 'message') addMessage(event.message);
  void queryClient.invalidateQueries({ queryKey: qk.conversations });
  void queryClient.invalidateQueries({ queryKey: qk.chatUnread });
}
