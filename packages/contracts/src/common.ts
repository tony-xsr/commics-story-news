import { z } from 'zod';

/** UI languages (prototype: src/data/languages.ts). Content falls back to `en`. */
export const Lang = z.enum(['en', 'vi', 'ja', 'ko', 'zh', 'es', 'fr']);
export type Lang = z.infer<typeof Lang>;

/** Opaque keyset cursor. Clients pass back `nextCursor` unchanged. */
export const Cursor = z.string().min(1).max(512);

export const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Page<T> = { items: T[]; nextCursor: string | null };
