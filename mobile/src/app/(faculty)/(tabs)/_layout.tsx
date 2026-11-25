import React from 'react';
import { Tabs, useRouter } from 'expo-router';
import { Home, BookOpen, BarChart3, User, ScanFace } from 'lucide-react-native';
import { FigmaBottomTabBar } from '@/navigation/FigmaBottomTabBar';
import { Colors } from '@/theme/tokens';
import { SessionStore } from '@/storage/sessionStore';

export default function FacultyTabsLayout() {
  const router = useRouter();
  const canScan = SessionStore.canScanAttendance();
  const canClasses = SessionStore.canViewClasses();
  const canReports = SessionStore.canViewReports();

  return (
    <Tabs
      tabBar={(props) => (
        <FigmaBottomTabBar
          {...props}
          centerAction={
            canScan
              ? {
                  icon: ScanFace,
                  label: 'Attendance',
                  onPress: () => {
                    router.push('/(faculty)/session/select-context' as any);
                  },
                  accessibilityLabel: 'Take Attendance Scanner',
                }
              : undefined
          }
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
          href: canClasses ? undefined : null,
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
          href: canReports ? undefined : null,
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
