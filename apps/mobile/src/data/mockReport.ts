export type ReportType = 'user' | 'story' | 'chapter' | 'comment';

export const OTHER_REASON = 'Other';

export const reportReasons: Record<ReportType, string[]> = {
  user: ['Spam or scam', 'Harassment or hate speech', 'Inappropriate content', 'Impersonation', OTHER_REASON],
  story: [
    'Copyright infringement',
    'Inappropriate or explicit content',
    'Spam',
    'Misleading information',
    OTHER_REASON,
  ],
  chapter: [
    'Missing or wrong content',
    'Inappropriate content',
    'Copyright infringement',
    'Formatting problems',
    OTHER_REASON,
  ],
  comment: ['Spam or scam', 'Harassment or hate speech', 'Inappropriate content', OTHER_REASON],
};

export const reportTitles: Record<ReportType, string> = {
  user: 'Report user',
  story: 'Report story',
  chapter: 'Report chapter',
  comment: 'Report comment',
};

export const isReportType = (value: string | undefined): value is ReportType =>
  value === 'user' || value === 'story' || value === 'chapter' || value === 'comment';

export const MIN_OTHER_DETAILS = 10;
export const MAX_DETAILS = 500;
