import { Pressable, Text, View } from 'react-native';
import { Conversation } from '../data/mockChats';
import { colors, radius, spacing, typography } from '../theme';
import { Avatar } from './Avatar';

type ChatListItemProps = {
  conversation: Conversation;
  onPress: () => void;
};

export function ChatListItem({ conversation, onPress }: ChatListItemProps) {
  const lastMessage = conversation.messages[conversation.messages.length - 1];

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.m,
        paddingVertical: spacing.l,
        paddingHorizontal: spacing.m,
        borderRadius: radius.m,
        backgroundColor: conversation.unread ? colors.container : 'transparent',
      }}>
      <Avatar size="chat" name={conversation.name} source={conversation.avatar} />

      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s }}>
          <Text numberOfLines={1} style={[typography.h4, { flexShrink: 1, color: colors.textPrimary }]}>
            {conversation.name}
          </Text>
          <Text style={[typography.subContent, { color: colors.textTertiary2 }]}>{conversation.timeAgo}</Text>
        </View>
        <Text numberOfLines={1} style={[typography.bodyContent, { color: colors.textSecondary }]}>
          {lastMessage?.text}
        </Text>
      </View>

      {conversation.unread ? (
        <View
          style={{
            position: 'absolute',
            top: spacing.s,
            right: spacing.s,
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: colors.primary,
          }}
        />
      ) : null}
    </Pressable>
  );
}
