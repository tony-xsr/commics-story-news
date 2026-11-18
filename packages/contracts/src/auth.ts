import { z } from 'zod';
import { Lang } from './common';

// ---- shared pieces ----

export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** 8–128 chars. Length beats complexity rules; breached-password check happens server-side. */
export const Password = z.string().min(8).max(128);

export const OtpCode = z.string().regex(/^\d{6}$/, 'must be 6 digits');

export const DisplayName = z.string().trim().min(1).max(40);

/** 3–20 chars: a–z, 0–9, `_` and `.`; case-insensitive. Public handle (profile URL, mentions). */
export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.]{3,20}$/, '3–20 letters, digits, _ or .');

/** Sent by clients on every request: `X-Device-Id`, `X-Platform`, `X-App-Version`. */
export const DeviceId = z.string().regex(/^[\w-]{8,128}$/);
export const Platform = z.enum(['ios', 'android', 'web']);
export type Platform = z.infer<typeof Platform>;

// ---- requests ----

/** `locale`: the app / web language — the new account's language and the language of the code email. */
/** Web forms: Cloudflare Turnstile token (required from the web when the API has TURNSTILE_SECRET_KEY). */
const CaptchaToken = z.string().min(1).max(2048);

export const RegisterRequest = z
  .object({
    email: Email,
    password: Password,
    username: Username,
    displayName: DisplayName.optional(),
    locale: Lang.optional(),
    captchaToken: CaptchaToken.optional(),
  })
  .strict();
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const VerifyEmailRequest = z.object({ email: Email, code: OtpCode }).strict();
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequest>;

export const ResendOtpRequest = z.object({ email: Email, locale: Lang.optional() }).strict();
export type ResendOtpRequest = z.infer<typeof ResendOtpRequest>;

/** `login` is an email or a username (the sign-in screen has one field for both). */
export const LoginRequest = z
  .object({
    login: z.string().trim().toLowerCase().min(3).max(254),
    password: z.string().min(1).max(128),
    captchaToken: CaptchaToken.optional(),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequest>;

/** Google Sign-In: the ID token from the native SDK / Google Identity Services. */
export const GoogleLoginRequest = z
  .object({ idToken: z.string().min(20).max(4096), nonce: z.string().min(16).max(128).optional() })
  .strict();
export type GoogleLoginRequest = z.infer<typeof GoogleLoginRequest>;

/**
 * Sign in with Apple. `nonce` is the raw value from `GET /v1/auth/nonce` (the client passes it — or its SHA-256 —
 * to Apple). Apple sends the user's name only on the FIRST authorization, so the client forwards it here.
 */
export const AppleLoginRequest = z
  .object({
    identityToken: z.string().min(20).max(4096),
    nonce: z.string().min(16).max(128),
    fullName: z
      .object({ givenName: z.string().trim().max(40).nullish(), familyName: z.string().trim().max(40).nullish() })
      .strict()
      .optional(),
  })
  .strict();
export type AppleLoginRequest = z.infer<typeof AppleLoginRequest>;

/** Phone sign-in: the Firebase ID token obtained after Firebase Phone Auth verified the SMS code on the device. */
export const PhoneLoginRequest = z.object({ idToken: z.string().min(20).max(4096) }).strict();
export type PhoneLoginRequest = z.infer<typeof PhoneLoginRequest>;

export const UsernameAvailabilityQuery = z.object({ username: Username }).strict();
export const UsernameAvailability = z.object({ username: z.string(), available: z.boolean() });
export type UsernameAvailability = z.infer<typeof UsernameAvailability>;

export const GuestLoginRequest = z.object({ deviceId: DeviceId }).strict();
export type GuestLoginRequest = z.infer<typeof GuestLoginRequest>;

export const RefreshRequest = z.object({ refreshToken: z.string().min(20).max(512) }).strict();
export type RefreshRequest = z.infer<typeof RefreshRequest>;

/** The email uses the account's language; `locale` (the screen's language) only when the account has none. */
export const ForgotPasswordRequest = z
  .object({ email: Email, locale: Lang.optional(), captchaToken: CaptchaToken.optional() })
  .strict();
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequest>;

export const ResetPasswordRequest = z.object({ email: Email, code: OtpCode, newPassword: Password }).strict();
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

/** `currentPassword` is required when the account already has one (social-only accounts can set a first password). */
export const ChangePasswordRequest = z
  .object({ currentPassword: z.string().min(1).max(128).optional(), newPassword: Password })
  .strict();
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

// ---- responses ----

export const MeUser = z.object({
  id: z.uuid(),
  displayName: z.string(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  emailVerified: z.boolean(),
  avatarUrl: z.string().nullable(),
  isGuest: z.boolean(),
  hasPassword: z.boolean(),
  providers: z.array(z.enum(['google', 'apple', 'phone'])),
  level: z.number().int(),
  locale: z.string(),
  createdAt: z.iso.datetime(),
  /** Confirmed once to be 18 or older (asked before the first 18+ story). */
  adultConfirmed: z.boolean(),
  /** 18+ stories hidden from lists (Settings). */
  hideAdult: z.boolean(),
});
export type MeUser = z.infer<typeof MeUser>;

/** PATCH /v1/me/content-preferences — 18+ content: confirm the age (once, not undoable here) / hide from lists. */
export const ContentPreferencesPatch = z
  .object({ confirmAdult: z.literal(true).optional(), hideAdult: z.boolean().optional() })
  .strict()
  .refine((v) => v.confirmAdult !== undefined || v.hideAdult !== undefined, { message: 'Nothing to change' });
export type ContentPreferencesPatch = z.infer<typeof ContentPreferencesPatch>;
export const ContentPreferences = z.object({ adultConfirmed: z.boolean(), hideAdult: z.boolean() });
export type ContentPreferences = z.infer<typeof ContentPreferences>;

export const AuthTokens = z.object({
  accessToken: z.string(),
  /** ISO time; refresh a little before this. */
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string(),
});
export type AuthTokens = z.infer<typeof AuthTokens>;

export const AuthResponse = AuthTokens.extend({ user: MeUser, isNewUser: z.boolean() });
export type AuthResponse = z.infer<typeof AuthResponse>;

/** Returned by register / resend / forgot — identical whether or not the email exists (no account enumeration). */
export const OtpSentResponse = z.object({ status: z.literal('otp_sent'), resendAfterSec: z.number().int() });
export type OtpSentResponse = z.infer<typeof OtpSentResponse>;

export const NonceResponse = z.object({ nonce: z.string(), expiresInSec: z.number().int() });
export type NonceResponse = z.infer<typeof NonceResponse>;

export const SessionItem = z.object({
  id: z.uuid(),
  platform: Platform.nullable(),
  appVersion: z.string().nullable(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  current: z.boolean(),
});
export type SessionItem = z.infer<typeof SessionItem>;

export const SessionList = z.object({ items: z.array(SessionItem) });
export type SessionList = z.infer<typeof SessionList>;
