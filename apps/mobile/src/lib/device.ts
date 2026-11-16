import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import { readSecure, writeSecure } from './secure';

const KEY = 'device-id';
let cached: string | null = null;

/** Stable per-install id (guest accounts, sessions, reward anti-farming). Kept in the Keychain / Keystore. */
export async function deviceId(): Promise<string> {
  if (cached) return cached;
  cached = (await readSecure<string>(KEY)) ?? `${Platform.OS}-${randomUUID()}`;
  await writeSecure(KEY, cached);
  return cached;
}

export const appVersion = Constants.expoConfig?.version ?? '0.0.0';
export const platform = (Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web') as
  | 'ios'
  | 'android'
  | 'web';
