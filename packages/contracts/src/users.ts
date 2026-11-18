import { z } from 'zod';
import { DisplayName, Username } from './auth';
import { Cursor, limit, page } from './common';
import { PremiumPlan } from './payments';

// Profiles (own + public), follows, blocks.

export const Gender = z.enum(['male', 'female', 'non_binary', 'undisclosed']);
export type Gender = z.infer<typeof Gender>;

/** Small user row for lists (followers, following, block list). */
export const UserCard = z.object({
  id: z.uuid(),
  displayName: z.string(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  level: z.number().int(),
});
export type UserCard = z.infer<typeof UserCard>;
export const UserPage = page(UserCard);
export type UserPage = z.infer<typeof UserPage>;
export const UserListQuery = z.object({ cursor: Cursor.optional(), limit: limit(50, 20) }).strict();
export type UserListQuery = z.infer<typeof UserListQuery>;

/** Same for every viewer (CDN-cacheable ~60 s). The caller's relation comes from /v1/me/relations/:id. */
export const PublicProfile = UserCard.extend({
  /** Active Premium plan (VIP crown on the profile), null when not Premium. */
  premium: PremiumPlan.nullable(),
  followers: z.number().int(),
  following: z.number().int(),
  storiesRead: z.number().int(),
  /** Unlocked badge ids, most recent first. */
  badgeIds: z.array(z.string()),
  stickerPacks: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type PublicProfile = z.infer<typeof PublicProfile>;

export const MyProfile = PublicProfile.extend({
  birthday: z.iso.date().nullable(),
  gender: Gender.nullable(),
  locale: z.string(),
  dmPolicy: z.enum(['everyone', 'following']),
  /** Usernames change at most once per 30 days; null = can change now. */
  usernameChangeableAt: z.iso.datetime().nullable(),
});
export type MyProfile = z.infer<typeof MyProfile>;

export const UpdateProfileRequest = z
  .object({
    displayName: DisplayName.optional(),
    username: Username.optional(),
    birthday: z.iso.date().nullable().optional(),
    gender: Gender.nullable().optional(),
    locale: z.enum(['en', 'vi', 'ja', 'ko', 'zh', 'es', 'fr']).optional(),
    /** Who may start a chat with me. */
    dmPolicy: z.enum(['everyone', 'following']).optional(),
  })
  .strict();
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

export const Relation = z.object({ following: z.boolean(), blocked: z.boolean(), blockedMe: z.boolean() });
export type Relation = z.infer<typeof Relation>;

/** Avatar upload: ticket (presigned PUT, ≤ 5 MB) → app PUTs the file → complete (server re-encodes, sets avatarUrl). */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AvatarUploadRequest = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/avif']),
    size: z.number().int().positive().max(AVATAR_MAX_BYTES),
  })
  .strict();
export type AvatarUploadRequest = z.infer<typeof AvatarUploadRequest>;

/**
 * Account deletion (App Store 5.1.1(v) / Google Play): immediate and final. Password accounts confirm with their
 * password. Store subscriptions keep billing until cancelled in the store — the response says so.
 */
export const DeleteAccountRequest = z
  .object({ confirm: z.literal('DELETE'), password: z.string().min(1).max(200).optional() })
  .strict();
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;
export const DeleteAccountResult = z.object({
  /** An auto-renewing store subscription is still active: tell the user to cancel it in the store. */
  activeStoreSubscription: z.enum(['ios', 'android']).nullable(),
});
export type DeleteAccountResult = z.infer<typeof DeleteAccountResult>;

/** `POST /v1/me/data/delete` — delete my activity data, keep the account (history, favorites, ratings, comments…). */
export const DeleteMyDataRequest = z.object({ confirm: z.literal('DELETE') }).strict();
export type DeleteMyDataRequest = z.infer<typeof DeleteMyDataRequest>;
export const DeleteMyDataResult = z.object({
  favorites: z.number().int(),
  history: z.number().int(),
  ratings: z.number().int(),
  comments: z.number().int(),
  notifications: z.number().int(),
  follows: z.number().int(),
});
export type DeleteMyDataResult = z.infer<typeof DeleteMyDataResult>;
