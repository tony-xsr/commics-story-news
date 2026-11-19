import { TabTrigger } from 'expo-router/ui';
import { View } from 'react-native';
import { useTabBarHidden } from '../context/TabBarContext';
import { useTabDots } from '../context/TabBadgeContext';
import { colors, shadows, spacing } from '../theme';
import { GenresIcon, HomeIcon, LibraryIcon, ProfileIcon } from './icons';
import { TabBarItem } from './TabBarItem';
import { useT } from '../context/LanguageContext';

export const TAB_BAR_HEIGHT = 86;

const TABS = [
  { name: 'home', label: 'tabs.home', Icon: HomeIcon },
  { name: 'genres', label: 'tabs.genres', Icon: GenresIcon },
  { name: 'library', label: 'tabs.library', Icon: LibraryIcon },
  { name: 'profile', label: 'tabs.profile', Icon: ProfileIcon },
] as const;

export function TabBar() {
  const hidden = useTabBarHidden();
  const dots = useTabDots();
  const t = useT();

  return (
    <View
      style={[
        {
          display: hidden ? 'none' : 'flex',
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: TAB_BAR_HEIGHT,
          flexDirection: 'row',
          paddingTop: spacing.m,
          backgroundColor: colors.surface,
          borderTopLeftRadius: 30,
          borderTopRightRadius: 30,
        },
        shadows.navigation,
      ]}
    >
      {TABS.map(({ name, label, Icon }) => (
        <TabTrigger key={name} name={name} asChild>
          <TabBarItem label={t(label)} Icon={Icon} dot={name === 'profile' ? dots.profile : false} />
        </TabTrigger>
      ))}
    </View>
  );
}
