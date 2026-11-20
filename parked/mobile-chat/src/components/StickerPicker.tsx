import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useStickers } from '../context/StickerContext';
import { colors, radius, spacing, typography } from '../theme';
import { Grid } from './Grid';
import { useT } from '../context/LanguageContext';

const PANEL_HEIGHT = 260;
const TAB_SIZE = 36;

/** Owned sticker packs (bought, level, Premium); tapping a sticker sends it. Opens on the pack chosen in My Sticker. */
export function StickerPicker({ onPick }: { onPick: (stickerId: string) => void }) {
  const t = useT();
  const { packs, activeId } = useStickers();
  const usable = packs.filter((p) => p.stickerIds?.length);
  const [selected, setSelected] = useState(activeId);
  const pack = usable.find((p) => p.id === selected) ?? usable[0];

  if (!pack) {
    return (
      <View style={{ height: PANEL_HEIGHT, alignItems: 'center', justifyContent: 'center', gap: spacing.s }}>
        <Text style={[typography.bodyContent, { color: colors.textSecondary }]}>{t('stickers.empty')}</Text>
        <Pressable onPress={() => router.push('/shop')} accessibilityRole="button" hitSlop={spacing.s}>
          <Text style={[typography.secondarySemibold, { color: colors.primary }]}>{t('stickers.goToShop')}</Text>
        </Pressable>
      </View>
    );
  }

  const items = (pack.stickerIds ?? []).map((id, i) => ({ id, image: pack.stickers?.[i] }));
  return (
    <View style={{ height: PANEL_HEIGHT, borderTopWidth: 1, borderColor: colors.gray }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.s, padding: spacing.s }}>
        {usable.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => setSelected(p.id)}
            accessibilityRole="tab"
            accessibilityLabel={p.name}
            accessibilityState={{ selected: p.id === pack.id }}
            style={{
              width: TAB_SIZE,
              height: TAB_SIZE,
              borderRadius: radius.s,
              backgroundColor: p.id === pack.id ? colors.container : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Image source={p.image} contentFit="contain" style={{ width: TAB_SIZE - 6, height: TAB_SIZE - 6 }} />
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.l, paddingBottom: spacing.l }}>
        <Grid
          items={items}
          keyExtractor={(s) => s.id}
          renderItem={(s) => (
            <Pressable onPress={() => onPick(s.id)} accessibilityRole="button" accessibilityLabel={t('chat.send')}>
              <Image source={s.image} contentFit="contain" style={{ width: '100%', aspectRatio: 1 }} />
            </Pressable>
          )}
          columns={4}
          columnGap={spacing.s}
          rowGap={spacing.s}
        />
      </ScrollView>
    </View>
  );
}
