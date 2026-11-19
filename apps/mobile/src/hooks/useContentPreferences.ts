import { useUpdateContentPreferences } from '@storyzio/api-client';
import type { ContentPreferencesPatch } from '@storyzio/contracts';
import { useAuth } from '../context/AuthContext';

/** 18+ choices of the signed-in reader (age confirmed, hide 18+), saved on the account. */
export function useContentPreferences() {
  const { user, updateUser } = useAuth();
  const mutation = useUpdateContentPreferences();
  const update = async (patch: ContentPreferencesPatch) => {
    const prefs = await mutation.mutateAsync(patch);
    updateUser(prefs);
    return prefs;
  };
  return {
    adultConfirmed: user?.adultConfirmed ?? false,
    hideAdult: user?.hideAdult ?? false,
    update,
    saving: mutation.isPending,
  };
}
