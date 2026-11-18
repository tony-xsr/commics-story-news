// Platform-neutral tokens from the prototype theme (storyzio/src/theme). Mobile wraps them in RN styles,
// web/admin map them to CSS variables / Tailwind theme.
export const colors = {
  primary: '#7D4FFE',
  primaryDark: '#6848C2',
  primaryLight: '#A993E3',
  container: '#F1EBFA',
  border: '#EBE5F3',
  border2: '#F4EDFF',
  textPrimary: '#1A1722',
  textSecondary: '#43414A',
  textTertiary: '#78767C',
  textTertiary2: '#96959A',
  textInput: '#98959F',
  input: '#E8E5EF',
  background: '#F8F5FF',
  surface: '#FFFFFF',
  gray: '#EEEEEE',
  success: '#1BA654',
  warning: '#F49908',
  error: '#FF2C48',
  information: '#3183FE',
  points: '#1BD7C6',
} as const;

export const spacing = { xs: 4, s: 8, m: 12, l: 16, xl: 24, '2xl': 32, '3xl': 40, '4xl': 48 } as const;
export const radius = spacing;

export const fontFamily = {
  light: 'SFProRounded-Light',
  regular: 'SFProRounded-Regular',
  semibold: 'SFProRounded-Semibold',
  bold: 'SFProRounded-Bold',
  heavy: 'SFProRounded-Heavy',
} as const;

export type ColorToken = keyof typeof colors;
export type SpacingToken = keyof typeof spacing;
