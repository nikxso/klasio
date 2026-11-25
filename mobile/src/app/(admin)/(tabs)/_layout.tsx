import React from 'react';
import { Tabs } from 'expo-router';
import { Home, Users, GraduationCap, Settings } from 'lucide-react-native';
import { FigmaBottomTabBar } from '@/navigation/FigmaBottomTabBar';
import { SessionStore } from '@/storage/sessionStore';

export default function AdminTabsLayout() {
  const isInstitutionalAdmin =
    SessionStore.canManageSettings() ||
    SessionStore.hasAnyRole([
      'ADMIN',
      'INSTITUTION_OWNER',
      'CENTRAL_INSTITUTION_ADMIN',
      'CAMPUS_ADMIN',
    ]);
  const canPeople = SessionStore.canManagePeople();
  const canAcademics = SessionStore.canManageAcademics();
  const canSettings = SessionStore.canManageSettings();

  return (
    <Tabs
      tabBar={(props) => <FigmaBottomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        animation: 'none',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          href: isInstitutionalAdmin ? undefined : null,
          title: 'Home',
          tabBarLabel: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Home size={size} color={color} strokeWidth={2} />
          ),
        }}
      />
      <Tabs.Screen
        name="people"
        options={{
          href: canPeople ? undefined : null,
          title: 'People',
          tabBarLabel: 'People',
          tabBarIcon: ({ color, size }) => (
            <Users size={size} color={color} strokeWidth={2} />
          ),
        }}
      />
      <Tabs.Screen
        name="academics"
        options={{
          href: canAcademics ? undefined : null,
          title: 'Academics',
          tabBarLabel: 'Academics',
          tabBarIcon: ({ color, size }) => (
            <GraduationCap size={size} color={color} strokeWidth={2} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          href: canSettings ? undefined : null,
          title: 'Settings',
          tabBarLabel: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Settings size={size} color={color} strokeWidth={2} />
          ),
        }}
      />
    </Tabs>
  );
}
