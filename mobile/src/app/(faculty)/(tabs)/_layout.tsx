import React from 'react';
import { Tabs, useRouter } from 'expo-router';
import { Home, BookOpen, BarChart3, User, ScanFace } from 'lucide-react-native';
import { FigmaBottomTabBar } from '@/navigation/FigmaBottomTabBar';
import { Colors } from '@/theme/tokens';

export default function FacultyTabsLayout() {
  const router = useRouter();

  return (
    <Tabs
      tabBar={(props) => (
        <FigmaBottomTabBar
          {...props}
          centerAction={{
            icon: ScanFace,
            label: 'Attendance',
            onPress: () => {
              router.push('/(faculty)/session/select-context' as any);
            },
            accessibilityLabel: 'Take Attendance Scanner',
          }}
        />
      )}
      screenOptions={{
        headerShown: false,
        animation: 'none',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarLabel: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Home size={size} color={color} strokeWidth={2} />
          ),
        }}
      />
      <Tabs.Screen
        name="assignments"
        options={{
          title: 'Classes',
          tabBarLabel: 'Classes',
          tabBarIcon: ({ color, size }) => (
            <BookOpen size={size} color={color} strokeWidth={2} />
          ),
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: 'Reports',
          tabBarLabel: 'Reports',
          tabBarIcon: ({ color, size }) => (
            <BarChart3 size={size} color={color} strokeWidth={2} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarLabel: 'Profile',
          tabBarIcon: ({ color, size }) => (
            <User size={size} color={color} strokeWidth={2} />
          ),
        }}
      />
    </Tabs>
  );
}
