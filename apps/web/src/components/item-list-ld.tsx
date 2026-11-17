import { JsonLd } from './json-ld';

/** schema.org ItemList of story pages (genre / rankings): helps search engines read the list as a collection. */
export function ItemListLd({ name, url, items }: { name: string; url: string; items: { name: string; url: string }[] }) {
  if (!items.length) return null;
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name,
        url,
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: items.length,
          itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, url: it.url, name: it.name })),
        },
      }}
    />
  );
}
