import type { ReportReason } from '@storyzio/contracts';

/** Prototype reason labels → server reason codes (labels with no own code are sent as `other` + the label). */
export const REASON_CODES: Record<string, ReportReason> = {
  'Spam or scam': 'spam',
  'Harassment or hate speech': 'harassment',
  'Inappropriate content': 'sexual',
  'Inappropriate or explicit content': 'sexual',
  'Copyright infringement': 'copyright',
  Spam: 'spam',
};

export function toReportReason(label: string, details: string): { reason: ReportReason; detail?: string } {
  const code = REASON_CODES[label];
  const text = details.trim();
  if (code) return { reason: code, detail: text || undefined };
  // "Impersonation", "Misleading information", "Missing or wrong content", "Other"…: keep the label for moderators.
  const detail = label === 'Other' ? text : [label, text].filter(Boolean).join(': ');
  return { reason: 'other', detail: detail.slice(0, 1000) || undefined };
}
