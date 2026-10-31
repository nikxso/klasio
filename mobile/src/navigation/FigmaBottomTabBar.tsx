import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Radii } from '@/theme/tokens';
import type { FigmaBottomTabBarProps } from './types';

export function FigmaBottomTabBar({
  state,
  descriptors,
  navigation,
  centerAction,
}: FigmaBottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const bottomPadding = Math.max(insets.bottom, 12);

  const visibleRoutes = state.routes.filter((route) => {
    const { options } = descriptors[route.key];
    const expoHref = (options as { href?: string | null }).href;
    return expoHref !== null;
  });

  const renderTabItem = (route: typeof state.routes[number]) => {
    const isFocused = state.routes[state.index].key === route.key;
    const { options } = descriptors[route.key];

    const label =
      options.tabBarLabel !== undefined
        ? options.tabBarLabel
        : options.title !== undefined
        ? options.title
        : route.name;

    const labelText = typeof label === 'string' ? label : route.name;

    const onPress = () => {
      const event = navigation.emit({
        type: 'tabPress',
        target: route.key,
        canPreventDefault: true,
      });

      if (!isFocused && !event.defaultPrevented) {
        navigation.navigate(route.name, route.params);
      }
    };

    const onLongPress = () => {
      navigation.emit({
        type: 'tabLongPress',
        target: route.key,
      });
    };

    const Icon = options.tabBarIcon;

    return (
      <Pressable
        key={route.key}
        accessibilityRole="button"
        accessibilityState={isFocused ? { selected: true } : {}}
        accessibilityLabel={options.tabBarAccessibilityLabel || labelText}
        testID={options.tabBarButtonTestID}
        onPress={onPress}
        onLongPress={onLongPress}
        style={styles.tabItem}
      >
        <View
          style={[
            styles.iconWrapper,
            isFocused && styles.iconWrapperActive,
          ]}
        >
          {Icon ? (
            Icon({
              focused: isFocused,
              color: isFocused ? Colors.forest : Colors.soft,
              size: 20,
            })
          ) : (
            <View style={styles.iconPlaceholder} />
          )}
        </View>
        <Text
          style={[
            styles.tabLabel,
            isFocused ? styles.tabLabelActive : styles.tabLabelInactive,
          ]}
          numberOfLines={1}
        >
          {labelText}
        </Text>
      </Pressable>
    );
  };

  const half = Math.ceil(visibleRoutes.length / 2);
  const leftRoutes = centerAction ? visibleRoutes.slice(0, half) : visibleRoutes;
  const rightRoutes = centerAction ? visibleRoutes.slice(half) : [];

  const CenterIcon = centerAction?.icon;

  return (
    <View
      style={[
        styles.container,
        {
          paddingBottom: bottomPadding,
        },
      ]}
    >
      <View style={styles.tabsRow}>
        {leftRoutes.map(renderTabItem)}

        {centerAction && (
          <Pressable
            onPress={centerAction.onPress}
            style={({ pressed }) => [
              styles.centerButtonWrapper,
              pressed && styles.centerButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={centerAction.accessibilityLabel || centerAction.label}
          >
            <View style={styles.centerButtonCircle}>
              {CenterIcon && (
                <CenterIcon size={24} color="#ffffff" strokeWidth={2.4} />
              )}
            </View>
            <Text style={styles.centerButtonLabel}>{centerAction.label}</Text>
          </Pressable>
        )}

        {rightRoutes.map(renderTabItem)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.card,
    borderTopWidth: 1,
    borderTopColor: Colors.line,
    paddingTop: 6,
    ...Platform.select({
      ios: {
        shadowColor: '#2a2338',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.05,
        shadowRadius: 8,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  tabsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-around',
    paddingHorizontal: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    minHeight: 48,
  },
  iconWrapper: {
    height: 32,
    paddingHorizontal: 16,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  iconWrapperActive: {
    backgroundColor: Colors.forest50,
  },
  iconPlaceholder: {
    width: 20,
    height: 20,
  },
  tabLabel: {
    fontSize: 11,
    textAlign: 'center',
  },
  tabLabelActive: {
    color: Colors.ink,
    fontWeight: '600',
  },
  tabLabelInactive: {
    color: Colors.soft,
    fontWeight: '400',
  },
  centerButtonWrapper: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -22,
  },
  centerButtonPressed: {
    transform: [{ scale: 0.95 }],
  },
  centerButtonCircle: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: Colors.forest,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: Colors.forest,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  centerButtonLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.forest,
    marginTop: 4,
  },
});
