import { useClearConversation, useMarkChatRead, useMessages, useSendMessage, useToggleBlock } from '@storyzio/api-client';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '../../components/Avatar';
import { BackIcon, DeleteIcon, MoreIcon, ReportIcon } from '../../components/icons';
import { LevelBadge } from '../../components/LevelBadge';
import { MessageBubble } from '../../components/MessageBubble';
import { MessageInput } from '../../components/MessageInput';
import { BlockIcon } from '../../components/icons/setting';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PopupMenu } from '../../components/PopupMenu';
import { StickerPicker } from '../../components/StickerPicker';
import { useAuth } from '../../context/AuthContext';
import { useChat } from '../../context/ChatContext';
import { useToast } from '../../context/ToastContext';
import { toMessage } from '../../features/chat/mappers';
import { errorMessage } from '../../lib/errors';
import { addMessage } from '../../lib/realtime';
import { colors, spacing, typography } from '../../theme';
import { useT } from '../../context/LanguageContext';

const HEADER_HEIGHT = 56;

export default function ChatRoomScreen() {
  const t = useT();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { conversations } = useChat();
  const conversation = conversations.find((item) => item.id === id);
  const { user } = useAuth();
  const { showToast } = useToast();
  const history = useMessages(id ?? '');
  const send = useSendMessage(id ?? '');
  const markRead = useMarkChatRead();
  const clear = useClearConversation();
  const toggleBlock = useToggleBlock();
  // History pages are newest first; the room shows oldest at the top.
  const messages = useMemo(
    () =>
      (history.data?.pages ?? [])
        .flatMap((p) => p.items)
        .reverse()
        .map((m) => toMessage(m, user?.id)),
    [history.data, user?.id],
  );
  const peerId = conversation?.peerId ?? '';
  const latestId = history.data?.pages[0]?.items[0]?.id;
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<'more' | null>(null);
  const [stickersOpen, setStickersOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Read up to the newest message whenever one arrives while the room is open.
  const { mutate: read } = markRead;
  useEffect(() => {
    if (id && latestId) read(id);
  }, [id, latestId, read]);

  if (!conversation) return null;

  const handleSend = () => {
    const message = text.trim();
    if (!message || send.isPending) return;
    setText('');
    deliver({ body: message }, () => setText(message));
  };

  // clientId makes a retry of the same message safe (the server keeps one copy).
  const deliver = (content: { body: string } | { stickerId: string }, onFail?: () => void) => {
    send.mutate(
      { body: '', ...content, clientId: randomUUID() },
      {
        onSuccess: addMessage,
        onError: (err) => {
          onFail?.();
          showToast(errorMessage(err));
        },
      },
    );
  };

  const confirmDelete = () => setConfirmingDelete(true);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.surface, paddingTop: insets.top }}>
      <View
        style={{
          height: HEADER_HEIGHT,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.s,
          paddingHorizontal: spacing.l,
        }}>
        <Pressable onPress={() => router.back()} hitSlop={spacing.s} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <BackIcon />
        </Pressable>
        <Pressable
          onPress={() => router.push(`/user/${peerId}`)}
          accessibilityRole="button"
          accessibilityLabel={conversation.name}>
          <Avatar size="comment" name={conversation.name} source={conversation.avatar} />
        </Pressable>
        <Pressable
          onPress={() => router.push(`/user/${peerId}`)}
          accessibilityRole="button"
          style={{ flexShrink: 1 }}>
          <Text numberOfLines={1} style={[typography.h4, { color: colors.textPrimary }]}>
            {conversation.name}
          </Text>
        </Pressable>
        <LevelBadge level={conversation.level} />
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => setMenu('more')}
          hitSlop={spacing.s}
          accessibilityRole="button"
          accessibilityLabel={t('common.moreOptions')}>
          <MoreIcon />
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.l, gap: spacing.l }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        onScroll={(e) => {
          // Near the top: load older messages.
          if (e.nativeEvent.contentOffset.y < 40 && history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
        }}
        scrollEventThrottle={200}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </ScrollView>

      <View style={{ paddingBottom: insets.bottom + spacing.s }}>
        <MessageInput
          value={text}
          onChangeText={setText}
          onSend={handleSend}
          onPressAdd={() => setStickersOpen((open) => !open)}
        />
        {stickersOpen ? <StickerPicker onPick={(stickerId) => deliver({ stickerId })} /> : null}
      </View>

      <PopupMenu
        visible={menu === 'more'}
        onClose={() => setMenu(null)}
        position={{ top: insets.top + HEADER_HEIGHT - 4, right: spacing.l }}
        items={[
          { label: t('report.titleUser'), icon: <ReportIcon />, onPress: () => router.push(`/report?type=user&id=${peerId}`) },
          { label: t('users.blockUser'), icon: <BlockIcon color={colors.error} />, destructive: true, onPress: () => setConfirmBlock(true) },
          { label: t('common.delete'), icon: <DeleteIcon />, destructive: true, onPress: confirmDelete },
        ]}
      />

      <ConfirmDialog
        visible={confirmingDelete}
        title={t('chat.deleteTitle')}
        message={t('chat.deleteMessage', { name: conversation.name })}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          setConfirmingDelete(false);
          clear.mutate(conversation.id, { onError: (err) => showToast(errorMessage(err)) });
          router.back();
        }}
        onClose={() => setConfirmingDelete(false)}
      />
      <ConfirmDialog
        visible={confirmBlock}
        title={t('users.blockTitle', { name: conversation.name })}
        message={t('users.blockMessage')}
        confirmLabel={t('users.block')}
        onConfirm={() => {
          setConfirmBlock(false);
          toggleBlock.mutate(
            { userId: peerId, block: true },
            { onSuccess: () => router.back(), onError: (err) => showToast(errorMessage(err)) },
          );
        }}
        onClose={() => setConfirmBlock(false)}
      />
    </KeyboardAvoidingView>
  );
}
