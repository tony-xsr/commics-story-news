// Stable error codes returned as { error: { code, message } }. Clients switch on `code`, never on message.
export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  INVALID_OTP: 'INVALID_OTP',
  SOCIAL_TOKEN_INVALID: 'SOCIAL_TOKEN_INVALID',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  CHAPTER_LOCKED: 'CHAPTER_LOCKED',
  INSUFFICIENT_COINS: 'INSUFFICIENT_COINS',
  INSUFFICIENT_POINTS: 'INSUFFICIENT_POINTS',
  ALREADY_UNLOCKED: 'ALREADY_UNLOCKED',
  GIFT_CODE_INVALID: 'GIFT_CODE_INVALID',
  GIFT_CODE_USED: 'GIFT_CODE_USED',
  PRICE_CHANGED: 'PRICE_CHANGED',
  UPGRADE_REQUIRED: 'UPGRADE_REQUIRED',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  PURCHASE_INVALID: 'PURCHASE_INVALID',
  PURCHASE_OWNED_BY_OTHER_USER: 'PURCHASE_OWNED_BY_OTHER_USER',
  ALREADY_SUBSCRIBED_ON_OTHER_PLATFORM: 'ALREADY_SUBSCRIBED_ON_OTHER_PLATFORM',
  ALREADY_ON_THIS_PLAN: 'ALREADY_ON_THIS_PLAN',
  WAIT_FOR_FREE_NOT_READY: 'WAIT_FOR_FREE_NOT_READY',
  CAPTCHA_FAILED: 'CAPTCHA_FAILED',
  /** Paid reading blocked by the anti-scraping guard (risk score); support can lift it. */
  READING_RESTRICTED: 'READING_RESTRICTED',
  /** Paid read from an app session without a valid integrity pass: run App Attest / Play Integrity, then retry. */
  INTEGRITY_REQUIRED: 'INTEGRITY_REQUIRED',
  /** The integrity proof was rejected (`details.reattest`: the iOS key is unknown → attest a new key). */
  INTEGRITY_FAILED: 'INTEGRITY_FAILED',
  /** The story is not available in the caller's country (HTTP 451). */
  GEO_BLOCKED: 'GEO_BLOCKED',
  /** This payment method is not set up on the server (e.g. Stripe keys missing). */
  PAYMENTS_UNAVAILABLE: 'PAYMENTS_UNAVAILABLE',
  /** The feature is switched off in the admin (Tính năng) for this platform: hide its UI. */
  FEATURE_DISABLED: 'FEATURE_DISABLED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
