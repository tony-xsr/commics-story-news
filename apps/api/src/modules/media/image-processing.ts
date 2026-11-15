import sharp, { type Metadata } from 'sharp';
import { AppError } from '../../common/errors/app-error';

export type ProcessedImage = { buffer: Buffer; width: number; height: number };

/** Real formats we accept, detected from the bytes (never from the file name or the declared type). */
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'avif']);
/** Decompression-bomb guard: refuse anything above ~100 megapixels before decoding it. */
const MAX_PIXELS = 100_000_000;

const COVER_WIDTH = 600;
const STICKER_SIZE = 512;
const AVATAR_SIZE = 256;
const PAGE_WIDTH = 1080;
/** Webtoon strips taller than this are cut into slices of SLICE_HEIGHT (smooth scrolling, lower memory on phones). */
const MAX_PAGE_HEIGHT = 4000;
const SLICE_HEIGHT = 1600;

const open = (input: Buffer) => sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' });

async function inspect(input: Buffer): Promise<{ width: number; height: number }> {
  let meta: Metadata;
  try {
    meta = await open(input).metadata();
  } catch {
    throw new AppError('VALIDATION', 'File is not a valid image');
  }
  if (!meta.format || !ACCEPTED.has(meta.format)) {
    throw new AppError('VALIDATION', `Unsupported image format${meta.format ? `: ${meta.format}` : ''}`);
  }
  if (!meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS) {
    throw new AppError('VALIDATION', 'Image dimensions are too large');
  }
  return { width: meta.width, height: meta.height };
}

/**
 * Story cover → WebP, max 600 px wide. Re-encoding drops EXIF/GPS and anything appended to the file
 * (polyglots, payloads); `.rotate()` applies the camera orientation before metadata is stripped.
 */
export async function processCover(input: Buffer): Promise<ProcessedImage> {
  await inspect(input);
  const { data, info } = await open(input)
    .rotate()
    .resize({ width: COVER_WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/** User avatar → square WebP (centre crop), 256 px; EXIF/GPS dropped by the re-encode. */
export async function processAvatar(input: Buffer): Promise<ProcessedImage> {
  await inspect(input);
  const { data, info } = await open(input)
    .rotate()
    .resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: 'cover', position: 'attention' })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/** Sticker / pack cover → WebP within 512×512, transparency kept (WebP has an alpha channel). */
export async function processSticker(input: Buffer): Promise<ProcessedImage> {
  await inspect(input);
  const { data, info } = await open(input)
    .rotate()
    .resize({ width: STICKER_SIZE, height: STICKER_SIZE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85, alphaQuality: 100 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/** Comic page → WebP at most 1080 px wide; very tall strips are split into ≤ 1600 px slices (in reading order). */
export async function processComicPage(input: Buffer): Promise<ProcessedImage[]> {
  await inspect(input);
  const resized = await open(input)
    .rotate()
    .resize({ width: PAGE_WIDTH, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = resized.info;
  const raw = { raw: { width, height, channels } } as const;

  if (height <= MAX_PAGE_HEIGHT) {
    const buffer = await sharp(resized.data, raw).webp({ quality: 80 }).toBuffer();
    return [{ buffer, width, height }];
  }
  const slices: ProcessedImage[] = [];
  for (let top = 0; top < height; top += SLICE_HEIGHT) {
    const sliceHeight = Math.min(SLICE_HEIGHT, height - top);
    const buffer = await sharp(resized.data, raw)
      .extract({ left: 0, top, width, height: sliceHeight })
      .webp({ quality: 80 })
      .toBuffer();
    slices.push({ buffer, width, height: sliceHeight });
  }
  return slices;
}
