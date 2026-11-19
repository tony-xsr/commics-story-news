import { colors, fontFamily } from '../theme';
import { parseBrightness, parseWarmth } from '../logic/light';
import { AUTO_SCROLL, parseAutoScroll } from '../logic/autoScroll';
import { parseMargin } from '../logic/margin';

export type ReaderThemeId = 'default' | 'light' | 'sepia' | 'dark';
export type ReadingMode = 'scroll' | 'page';
export type ReaderFontId = 'default' | 'merriweather' | 'openSans' | 'bitter';

export type ReaderSettings = {
  fontSize: number;
  lineSpacing: number;
  font: ReaderFontId;
  mode: ReadingMode;
  theme: ReaderThemeId;
  /** Screen brightness while reading (0.05–1); null = the phone's own setting. */
  brightness: number | null;
  /** Warm (night) filter level 0–5. */
  warmth: number;
  /** Auto-scroll speed level 1–5 (scroll mode). */
  autoScroll: number;
  /** Side margin level 0–4 (logic/margin.ts). */
  margin: number;
  /** Reader orientation: follow the phone / always portrait / always landscape (the rest of the app is portrait). */
  orientation: ReaderOrientation;
  /** Android: volume keys turn pages. */
  volumeKeys: boolean;
};

export type ReaderOrientation = 'auto' | 'portrait' | 'landscape';
const ORIENTATIONS: ReaderOrientation[] = ['auto', 'portrait', 'landscape'];

export const defaultReaderSettings: ReaderSettings = {
  fontSize: 18,
  lineSpacing: 1.5,
  font: 'default',
  mode: 'scroll',
  theme: 'default',
  brightness: null,
  warmth: 0,
  autoScroll: AUTO_SCROLL.default,
  margin: 0,
  orientation: 'portrait',
  volumeKeys: false,
};

export const FONT_SIZE_RANGE = { min: 12, max: 28, step: 2 } as const;
export const LINE_SPACING_RANGE = { min: 1, max: 2.4, step: 0.1 } as const;

export const readerFonts: { id: ReaderFontId; label: string; family: string }[] = [
  { id: 'default', label: 'Default', family: fontFamily.regular },
  { id: 'merriweather', label: 'Merriweather', family: 'Merriweather_400Regular' },
  { id: 'openSans', label: 'Open Sans', family: 'OpenSans_400Regular' },
  { id: 'bitter', label: 'Bitter', family: 'Bitter_400Regular' },
];

export const getReaderFontFamily = (id: ReaderFontId) =>
  readerFonts.find((font) => font.id === id)?.family ?? fontFamily.regular;

export type ReaderTheme = {
  id: ReaderThemeId;
  label: string;
  background: string;
  text: string;
  muted: string;
  border: string;
  dark: boolean;
};

export const readerThemes: ReaderTheme[] = [
  {
    id: 'default',
    label: 'Default',
    background: '#F8F5FF',
    text: '#1A1722',
    muted: '#78767C',
    border: '#EBE5F3',
    dark: false,
  },
  {
    id: 'light',
    label: 'Light',
    background: '#FFFFFF',
    text: '#1A1722',
    muted: '#78767C',
    border: '#EBE5F3',
    dark: false,
  },
  {
    id: 'sepia',
    label: 'Sepia',
    background: '#F5EEDC',
    text: '#1A1722',
    muted: '#78767C',
    border: '#E6DCC3',
    dark: false,
  },
  {
    id: 'dark',
    label: 'Dark',
    background: '#1A1722',
    text: colors.input,
    muted: '#96959A',
    border: '#2E2A38',
    dark: true,
  },
];

export const getReaderTheme = (id: ReaderThemeId) => readerThemes.find((theme) => theme.id === id) ?? readerThemes[0];

const isReaderThemeId = (value: unknown): value is ReaderThemeId => readerThemes.some((theme) => theme.id === value);
const isReadingMode = (value: unknown): value is ReadingMode => value === 'scroll' || value === 'page';
const isReaderFontId = (value: unknown): value is ReaderFontId => readerFonts.some((font) => font.id === value);

export function parseReaderSettings(raw: string | null): ReaderSettings {
  if (!raw) return defaultReaderSettings;

  let value: Partial<Record<keyof ReaderSettings, unknown>>;
  try {
    value = JSON.parse(raw);
  } catch {
    return defaultReaderSettings;
  }

  const fontSize =
    typeof value.fontSize === 'number' && value.fontSize >= FONT_SIZE_RANGE.min && value.fontSize <= FONT_SIZE_RANGE.max
      ? value.fontSize
      : defaultReaderSettings.fontSize;
  const lineSpacing =
    typeof value.lineSpacing === 'number' &&
    value.lineSpacing >= LINE_SPACING_RANGE.min &&
    value.lineSpacing <= LINE_SPACING_RANGE.max
      ? value.lineSpacing
      : defaultReaderSettings.lineSpacing;

  return {
    fontSize,
    lineSpacing,
    font: isReaderFontId(value.font) ? value.font : defaultReaderSettings.font,
    mode: isReadingMode(value.mode) ? value.mode : defaultReaderSettings.mode,
    theme: isReaderThemeId(value.theme) ? value.theme : defaultReaderSettings.theme,
    brightness: parseBrightness(value.brightness),
    warmth: parseWarmth(value.warmth),
    autoScroll: parseAutoScroll(value.autoScroll),
    margin: parseMargin(value.margin),
    orientation: ORIENTATIONS.includes(value.orientation as ReaderOrientation)
      ? (value.orientation as ReaderOrientation)
      : defaultReaderSettings.orientation,
    volumeKeys: value.volumeKeys === true,
  };
}
