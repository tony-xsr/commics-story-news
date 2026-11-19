export const normalizeText = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();

export function matchesQuery(query: string, ...fields: string[]) {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const haystack = normalizeText(fields.join(' '));
  return tokens.every((token) => haystack.includes(token));
}


const words = (text: string) => normalizeText(text).split(/\s+/).filter(Boolean);

function searchScore(query: string, primary: string, secondary = '') {
  const tokens = words(query);
  if (tokens.length === 0) return 3;

  const name = normalizeText(primary);
  if (name.startsWith(tokens.join(' '))) return 3;

  const nameWords = words(primary);
  if (tokens.every((token) => nameWords.some((word) => word.startsWith(token)))) return 2;

  return matchesQuery(query, primary, secondary) ? 1 : 0;
}

export function rankBySearch<T>(
  items: readonly T[],
  query: string,
  primary: (item: T) => string,
  secondary?: (item: T) => string,
): T[] {
  if (words(query).length === 0) return [...items];

  return items
    .map((item, index) => ({ item, index, score: searchScore(query, primary(item), secondary?.(item)) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}