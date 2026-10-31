import type React from 'react';
import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs';

export interface CenterTabAction {
  icon: React.ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
}

export interface FigmaBottomTabBarProps extends BottomTabBarProps {
  centerAction?: CenterTabAction;
}
