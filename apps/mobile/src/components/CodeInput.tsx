import { useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { colors, radius, spacing, typography } from '../theme';
import { useT } from '../context/LanguageContext';

type CodeInputProps = {
  value: string;
  onChange: (value: string) => void;
  length?: number;
};

export function CodeInput({ value, onChange, length = 6 }: CodeInputProps) {
  const t = useT();
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      onPress={() => inputRef.current?.focus()}
      accessibilityLabel={t('auth.verifyTitle')}
      style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.s }}
    >
      {Array.from({ length }, (_, index) => {
        const active = focused && index === Math.min(value.length, length - 1);
        return (
          <View
            key={index}
            style={{
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.m,
              borderWidth: 1,
              borderColor: active ? colors.primary : 'transparent',
              backgroundColor: colors.input,
            }}
          >
            <Text style={[typography.h4, { color: colors.textPrimary }]}>{value[index] ?? ''}</Text>
          </View>
        );
      })}

      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, length))}
        keyboardType="number-pad"
        maxLength={length}
        autoFocus
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        caretHidden
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
      />
    </Pressable>
  );
}
