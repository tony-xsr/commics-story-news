import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, spacing, typography } from '../theme';

const BOX_SIZE = 16;

type CheckboxProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
};

/** Small checkbox with a label; the whole row is tappable. */
export function Checkbox({ checked, onChange, label }: CheckboxProps) {
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      hitSlop={spacing.s}
      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.s }}
    >
      <View
        style={{
          width: BOX_SIZE,
          height: BOX_SIZE,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 4,
          borderWidth: 1,
          borderColor: checked ? colors.primary : colors.textTertiary2,
          backgroundColor: checked ? `${colors.primary}1A` : colors.surface,
        }}
      >
        {checked ? (
          <Svg width={10} height={10} viewBox="0 0 10 10" fill="none">
            <Path
              d="M1.5 5.2L4 7.5L8.5 2.5"
              stroke={colors.primary}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        ) : null}
      </View>
      <Text style={[typography.caption, { color: colors.textSecondary }]}>{label}</Text>
    </Pressable>
  );
}
