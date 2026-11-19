import type { Endpoints } from '@storyzio/api-client';
import { AVATAR_MAX_BYTES, type AvatarUploadRequest, type MyProfile } from '@storyzio/contracts';
import * as ImagePicker from 'expo-image-picker';

/** Picker output is a cropped square JPEG; quality keeps phone photos well under the 5 MB limit. */
const PICK_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 0.7,
};

export type AvatarOutcome = { status: 'done'; profile: MyProfile } | { status: 'cancelled' } | { status: 'too_large' };

/**
 * Pick a photo → upload ticket → PUT the file straight to storage (signed for its type + exact size) → complete:
 * the server re-encodes it and returns the profile with the new avatar.
 */
export async function pickAndUploadAvatar(api: Endpoints): Promise<AvatarOutcome> {
  const picked = await ImagePicker.launchImageLibraryAsync(PICK_OPTIONS);
  const asset = picked.canceled ? null : picked.assets[0];
  if (!asset) return { status: 'cancelled' };

  const blob = await (await fetch(asset.uri)).blob();
  if (blob.size > AVATAR_MAX_BYTES) return { status: 'too_large' };
  const contentType = (['image/png', 'image/webp', 'image/avif'].includes(asset.mimeType ?? '')
    ? asset.mimeType
    : 'image/jpeg') as AvatarUploadRequest['contentType'];

  const ticket = await api.users.avatarTicket({ contentType, size: blob.size });
  const put = await fetch(ticket.uploadUrl, { method: 'PUT', headers: ticket.headers, body: blob });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return { status: 'done', profile: await api.users.avatarComplete(ticket.id) };
}
