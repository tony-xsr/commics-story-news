import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { processComicPage, processCover, processSticker } from './image-processing';

const image = (width: number, height: number, format: 'png' | 'jpeg' = 'png') =>
  sharp({ create: { width, height, channels: 3, background: { r: 125, g: 79, b: 254 } } })
    [format]()
    .toBuffer();

describe('processCover', () => {
  it('re-encodes to WebP, max 600 px wide, keeping the aspect ratio', async () => {
    const out = await processCover(await image(1200, 1600));
    expect(out).toMatchObject({ width: 600, height: 800 });
    expect((await sharp(out.buffer).metadata()).format).toBe('webp');
  });

  it('never upscales small images', async () => {
    expect(await processCover(await image(300, 400))).toMatchObject({ width: 300, height: 400 });
  });

  it('strips EXIF / GPS metadata', async () => {
    const withExif = await sharp(await image(800, 1000, 'jpeg'))
      .withExif({ IFD0: { Make: 'SecretPhone', Software: 'leak' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const out = await processCover(withExif);
    expect((await sharp(out.buffer).metadata()).exif).toBeUndefined();
    expect(out.buffer.includes(Buffer.from('SecretPhone'))).toBe(false);
  });

  it('drops payloads appended to an image (polyglot files)', async () => {
    const polyglot = Buffer.concat([await image(400, 400), Buffer.from('<script>alert(1)</script>')]);
    const out = await processCover(polyglot);
    expect(out.buffer.includes(Buffer.from('<script>'))).toBe(false);
  });

  it.each([
    ['plain text renamed to .png', Buffer.from('definitely not an image')],
    ['an HTML file', Buffer.from('<html><script>alert(1)</script></html>')],
    ['an empty file', Buffer.alloc(0)],
  ])('rejects %s', async (_, buf) => {
    await expect(processCover(buf)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects unsupported real formats (e.g. SVG can carry scripts)', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    await expect(processCover(svg)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects decompression bombs before decoding them (header claims 30000×30000)', async () => {
    // A tiny PNG whose IHDR declares a huge size: refused from the header, never decoded.
    const small = await image(10, 10);
    const bomb = Buffer.from(small);
    bomb.writeUInt32BE(30_000, 16);
    bomb.writeUInt32BE(30_000, 20);
    await expect(processCover(bomb)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('processComicPage', () => {
  it('normal page: one WebP at most 1080 px wide', async () => {
    const pages = await processComicPage(await image(1440, 2000));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ width: 1080, height: 1500 });
  });

  it('a long webtoon strip is cut into ≤ 1600 px slices covering the whole image', async () => {
    const pages = await processComicPage(await image(800, 9000));
    expect(pages.map((p) => p.height)).toEqual([1600, 1600, 1600, 1600, 1600, 1000]);
    expect(pages.every((p) => p.width === 800)).toBe(true);
    expect(pages.reduce((sum, p) => sum + p.height, 0)).toBe(9000);
  });
});

describe('processSticker', () => {
  it('fits within 512×512 and keeps transparency', async () => {
    const png = await sharp({
      create: { width: 1000, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const out = await processSticker(png);
    expect(out).toMatchObject({ width: 512, height: 307 });
    const meta = await sharp(out.buffer).metadata();
    expect(meta).toMatchObject({ format: 'webp', hasAlpha: true });
  });
});
