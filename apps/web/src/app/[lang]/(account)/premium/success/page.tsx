import type { Metadata } from 'next';
import { PremiumDone } from '@/components/premium';
import { routeLocale, translator } from '@/i18n';

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  return { title: translator(routeLocale((await params).lang))('premium.welcome'), robots: { index: false } };
}

export default function PremiumSuccessPage() {
  return <PremiumDone />;
}
