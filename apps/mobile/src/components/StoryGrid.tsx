import { Story } from '../data/mockStories';
import { spacing } from '../theme';
import { Grid } from './Grid';
import { StoryCard } from './StoryCard';

export function StoryGrid({ stories }: { stories: readonly Story[] }) {
  return (
    <Grid
      items={stories}
      keyExtractor={(story) => story.id}
      renderItem={(story) => <StoryCard story={story} />}
      columnGap={spacing.s}
      rowGap={spacing.l}
    />
  );
}
