import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ChatListItem } from '../../components/ChatListItem';
import { NoResults } from '../../components/NoResults';
import { CreateChatIcon } from '../../components/icons';
import { SearchInput } from '../../components/SearchInput';
import { StickyScreen } from '../../components/StickyScreen';
import { useChat } from '../../context/ChatContext';
import { useTabContentBottom } from '../../context/ContinueReadingContext';
import { colors, spacing, typography } from '../../theme';
import { rankBySearch } from '../../utils/search';
import { useT } from '../../context/LanguageContext';

const TITLE_ROW_HEIGHT = 40;
const TITLE_TEXT = { lineHeight: 34, includeFontPadding: false, textAlignVertical: 'center' } as const;

export default function ChatScreen() {
  const tabContentBottom = useTabContentBottom();
  const t = useT();
  const { conversations, loaded } = useChat();
  const [query, setQuery] = useState('');

  // Blocked people are already left out by the server.
  const visible = rankBySearch(conversations, query, (conversation) => conversation.name);

  return (
    <StickyScreen
      topGap={0}
      bottomGap={0}
      header={
        <View style={{ gap: spacing.l, paddingHorizontal: spacing.l }}>
          <View style={{ height: TITLE_ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[typography.h1, TITLE_TEXT, { color: colors.textPrimary }]}>{t('tabs.chat')}</Text>
            <Pressable hitSlop={spacing.s} accessibilityRole="button" accessibilityLabel={t('chat.newChat')}>
              <CreateChatIcon />
            </Pressable>
          </View>

          <SearchInput placeholder={t('chat.searchPlaceholder')} value={query} onChangeText={setQuery} />
        </View>
      }
      contentContainerStyle={{
        paddingTop: spacing.s,
        paddingHorizontal: spacing.l,
        paddingBottom: tabContentBottom,
      }}>
      {visible.length > 0 ? (
        <View style={{ gap: spacing.s }}>
          {visible.map((conversation) => (
            <ChatListItem
              key={conversation.id}
              conversation={conversation}
              onPress={() => router.push(`/chat/${conversation.id}`)}
            />
          ))}
        </View>
      ) : loaded ? (
        <NoResults message={t('chat.empty')} hint={t('chat.emptyHint')} />
      ) : null}
    </StickyScreen>
  );
}
