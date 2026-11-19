import { useBlocks } from '@storyzio/api-client';
import { useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { Comment } from '../data/mockStoryDetail';

/**
 * Hides comments of blocked users. Comment lists are public (CDN-cached, the same for everyone), so the
 * filtering happens here with the user's own block list.
 */
export function useBlockedFilter() {
  const { isSignedIn } = useAuth();
  const blocks = useBlocks(isSignedIn);
  const blocked = useMemo(() => new Set((blocks.data?.items ?? []).map((u) => u.id)), [blocks.data]);
  return useCallback(
    (comments: readonly Comment[]) => comments.filter((c) => !c.authorId || !blocked.has(c.authorId)),
    [blocked],
  );
}
