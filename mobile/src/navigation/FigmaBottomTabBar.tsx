import React, { useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors } from '@/theme/tokens';
import type { FigmaBottomTabBarProps } from './types';

interface TabItemButtonProps {
  route: any;
  isFocused: boolean;
  options: any;
  labelText: string;
  onPress: () => void;
  onLongPress: () => void;
}

function TabItemButton({
  route,
  isFocused,
  options,
  labelText,
  onPress,
  onLongPress,
}: TabItemButtonProps) {
  const anim = useRef(new Animated.Value(isFocused ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: isFocused ? 1 : 0,
      useNativeDriver: true,
      friction: 8,
      tension: 60,
    }).start();
  }, [isFocused, anim]);

  const Icon = options.tabBarIcon;

  // Scale icon subtly: 1.0 -> 1.06
  const iconScale = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, 1.06],
  });

  // Icon opacity: 0.72 -> 1.0
  const iconOpacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.72, 1.0],
  });

  // Indicator scaleX: 0.2 -> 1.0
  const indicatorScaleX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.2, 1.0],
  });

  return (
    <Pressable
      key={route.key}
      accessibilityRole="button"
      accessibilityState={isFocused ? { selected: true } : {}}
      accessibilityLabel={options.tabBarAccessibilityLabel || labelText}
      testID={options.tabBarButtonTestID}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.tabItem,
        pressed && styles.tabItemPressed,
      ]}
    >
      <Animated.View
        style={[
          styles.iconWrapper,
          {
            transform: [{ scale: iconScale }],
            opacity: iconOpacity,
          },
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
      </Animated.View>

      <Text
        style={[
          styles.tabLabel,
          isFocused ? styles.tabLabelActive : styles.tabLabelInactive,
        ]}
        numberOfLines={1}
      >
        {labelText}
      </Text>

      {/* Subtle selection capsule indicator beneath tab */}
      <Animated.View
        style={[
          styles.activeIndicator,
          {
            opacity: anim,
            transform: [{ scaleX: indicatorScaleX }],
          },
        ]}
      />
    </Pressable>
  );
}

export function FigmaBottomTabBar({
  state,
  descriptors,
  navigation,
  centerAction,
}: FigmaBottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const bottomPadding = Math.max(insets.bottom, 10);

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

    return (
      <TabItemButton
        key={route.key}
        route={route}
        isFocused={isFocused}
        options={options}
        labelText={labelText}
        onPress={onPress}
        onLongPress={onLongPress}
      />
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
        shadowColor: '#302630',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.05,
        shadowRadius: 8,
      },
      android: {
        elevation: 6,
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
    paddingTop: 4,
    paddingBottom: 2,
    minHeight: 50,
  },
  tabItemPressed: {
    opacity: 0.75,
  },
  iconWrapper: {
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  iconPlaceholder: {
    width: 20,
    height: 20,
  },
  tabLabel: {
    fontSize: 11,
    textAlign: 'center',
    letterSpacing: -0.1,
  },
  tabLabelActive: {
    color: Colors.forest,
    fontWeight: '600',
  },
  tabLabelInactive: {
    color: Colors.soft,
    fontWeight: '400',
  },
  activeIndicator: {
    width: 14,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: Colors.forest,
    marginTop: 3,
  },
  centerButtonWrapper: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -22,
  },
  centerButtonPressed: {
    transform: [{ scale: 0.94 }],
  },
  centerButtonCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
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
