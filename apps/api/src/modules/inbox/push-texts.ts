// Texts of event pushes / notices. Missing language → English. Keep them short (lock screen).

type Texts = {
  newChapter: (story: string, n: number) => { title: string; body: string };
  newChapters: (count: number, stories: string[]) => { title: string; body: string };
  coinsExpiring: (amount: number, date: string) => { title: string; body: string };
  levelUp: (level: number) => { title: string; body: string };
};

const list = (stories: string[], more: number, and: string) =>
  stories.slice(0, 3).join(', ') + (more > 0 ? ` ${and} ${more}` : '');

const TEXTS: Record<string, Texts> = {
  en: {
    newChapter: (story, n) => ({ title: story, body: `Chapter ${n} is out` }),
    newChapters: (count, stories) => ({
      title: `${count} stories you follow have new chapters`,
      body: list(stories, count - 3, '+'),
    }),
    coinsExpiring: (amount, date) => ({
      title: `${amount} coins expire soon`,
      body: `Use them before ${date} so they don't go to waste`,
    }),
    levelUp: (level) => ({ title: `Congrats! You reached level ${level}`, body: 'See your new benefits on the Level page' }),
  },
  vi: {
    newChapter: (story, n) => ({ title: story, body: `Đã có chương ${n}` }),
    newChapters: (count, stories) => ({
      title: `${count} truyện bạn theo dõi có chương mới`,
      body: list(stories, count - 3, 'và'),
    }),
    coinsExpiring: (amount, date) => ({
      title: `${amount} coin sắp hết hạn`,
      body: `Dùng trước ${date} để không bị mất nhé`,
    }),
    levelUp: (level) => ({ title: `Chúc mừng! Bạn đã lên level ${level}`, body: 'Xem quyền lợi mới trong trang Level' }),
  },
  ja: {
    newChapter: (story, n) => ({ title: story, body: `第${n}話が公開されました` }),
    newChapters: (count, stories) => ({ title: `フォロー中の${count}作品に新しい話があります`, body: list(stories, count - 3, 'ほか') }),
    coinsExpiring: (amount, date) => ({ title: `${amount} コインの有効期限が近づいています`, body: `${date}までに使い切りましょう` }),
    levelUp: (level) => ({ title: `おめでとう！レベル${level}になりました`, body: 'マイレベルで新しい特典をチェック' }),
  },
  ko: {
    newChapter: (story, n) => ({ title: story, body: `${n}화가 공개되었습니다` }),
    newChapters: (count, stories) => ({ title: `팔로우한 작품 ${count}편에 새 회차가 있습니다`, body: list(stories, count - 3, '외') }),
    coinsExpiring: (amount, date) => ({ title: `${amount} 코인이 곧 만료됩니다`, body: `${date}까지 사용하세요` }),
    levelUp: (level) => ({ title: `축하합니다! 레벨 ${level} 달성`, body: '내 레벨에서 새 혜택을 확인하세요' }),
  },
  zh: {
    newChapter: (story, n) => ({ title: story, body: `第 ${n} 章已更新` }),
    newChapters: (count, stories) => ({ title: `你关注的 ${count} 部作品有新章节`, body: list(stories, count - 3, '等') }),
    coinsExpiring: (amount, date) => ({ title: `${amount} 金币即将过期`, body: `请在 ${date} 前使用，别浪费哦` }),
    levelUp: (level) => ({ title: `恭喜！你已升到 ${level} 级`, body: '去等级页面看看新权益' }),
  },
  es: {
    newChapter: (story, n) => ({ title: story, body: `Ya salió el capítulo ${n}` }),
    newChapters: (count, stories) => ({ title: `${count} historias que sigues tienen capítulos nuevos`, body: list(stories, count - 3, 'y') }),
    coinsExpiring: (amount, date) => ({ title: `${amount} monedas caducan pronto`, body: `Úsalas antes del ${date} para no perderlas` }),
    levelUp: (level) => ({ title: `¡Enhorabuena! Llegaste al nivel ${level}`, body: 'Mira tus nuevas ventajas en la página de Nivel' }),
  },
  fr: {
    newChapter: (story, n) => ({ title: story, body: `Le chapitre ${n} est sorti` }),
    newChapters: (count, stories) => ({ title: `${count} histoires suivies ont de nouveaux chapitres`, body: list(stories, count - 3, 'et') }),
    coinsExpiring: (amount, date) => ({ title: `${amount} pièces expirent bientôt`, body: `Utilisez-les avant le ${date} pour ne pas les perdre` }),
    levelUp: (level) => ({ title: `Bravo ! Vous avez atteint le niveau ${level}`, body: 'Découvrez vos nouveaux avantages sur la page Niveau' }),
  },
};

export const textsFor = (lang: string): Texts => TEXTS[lang] ?? TEXTS.en!;

/** Local date for the user in their language, e.g. "30 thg 10" (vi), "Oct 30" (en), "10月30日" (ja). */
export function localDate(date: Date, lang: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: safeZone(timeZone) };
  return new Intl.DateTimeFormat(lang in TEXTS ? lang : 'en', options).format(date);
}

/** No pushes between 22:00 and 08:00 in the user's time zone (invalid zone → UTC). */
export function isQuietHour(timeZone: string, now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: safeZone(timeZone) }).format(now),
  );
  return hour >= 22 || hour < 8;
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}
