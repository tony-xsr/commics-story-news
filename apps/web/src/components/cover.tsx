import Image from 'next/image';

/** Story cover at the app's 3:4 ratio; a fixed box keeps CLS at zero while it loads. */
export function Cover({ src, alt, priority = false, sizes = '(min-width: 768px) 160px, 33vw' }: {
  src: string | null;
  alt: string;
  priority?: boolean;
  sizes?: string;
}) {
  return (
    <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-container">
      {src ? (
        <Image src={src} alt={alt} fill sizes={sizes} priority={priority} className="object-cover" />
      ) : null}
    </div>
  );
}
