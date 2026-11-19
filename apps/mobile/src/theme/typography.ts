import { TextStyle } from 'react-native';

export const fontFamily = {
  light: 'SFProRounded-Light',
  regular: 'SFProRounded-Regular',
  semibold: 'SFProRounded-Semibold',
  bold: 'SFProRounded-Bold',
  heavy: 'SFProRounded-Heavy',
} as const;

const make = (fontSize: number, family: keyof typeof fontFamily, lineHeight?: number): TextStyle => ({
  fontFamily: fontFamily[family],
  fontSize,
  ...(lineHeight ? { lineHeight } : null),
});

export const typography = {
  display: make(50, 'heavy'),
  h1: make(28, 'bold'),
  h2: make(22, 'bold'),
  h3: make(18, 'bold'),
  h4: make(16, 'bold'),
  contentNovel: make(18, 'regular', 24),
  bodyContent: make(16, 'regular', 22),
  subContent: make(14, 'regular', 20),
  bodyContentSemibold: make(16, 'semibold'),
  secondaryRegular: make(14, 'regular'),
  secondarySemibold: make(14, 'semibold'),
  button: make(16, 'semibold'),
  caption: make(12, 'regular'),
  caption2: make(12, 'bold'),
} as const;

export type TypographyToken = keyof typeof typography;
