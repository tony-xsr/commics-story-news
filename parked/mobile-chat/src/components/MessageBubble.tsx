import { Image } from 'expo-image';
import { Text, View } from 'react-native';
import { Message } from '../data/mockChats';
import { colors, radius, spacing, typography } from '../theme';
import { useT } from '../context/LanguageContext';

const STICKER_SIZE = 120;

export function MessageBubble({ message }: { message: Message }) {
  const t = useT();
  const { mine, text, sticker } = message;

  if (sticker) {
    return (
      <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', gap: spacing.xs }}>
        <Image source={sticker} contentFit="contain" style={{ width: STICKER_SIZE, height: STICKER_SIZE }} accessibilityLabel={t('comments.sticker')} />
      </View>
    );
  }

  return (
    <View
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '68%',
        padding: spacing.m,
        borderRadius: radius.m,
        backgroundColor: mine ? colors.primary : colors.gray,
      }}>
      <Text style={[typography.bodyContent, { color: mine ? colors.surface : colors.textPrimary }]}>{text}</Text>
    </View>
  );
}
