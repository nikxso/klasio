import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { SessionStore } from '@/storage/sessionStore';
import { AccessRestrictedView } from '@/components/ui/kit';

export default function FacultyStackLayout() {
  const router = useRouter();
  const user = SessionStore.getUser();

  if (user?.role?.toUpperCase() === 'STUDENT') {
    return (
      <AccessRestrictedView
        title="Faculty Workspace Restricted"
        message="Student accounts cannot access faculty or administrative workflows."
        requiredCapability="attendance.session.start or faculty role"
        onBack={() => router.replace('/(student)' as any)}
      />
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'none',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="section/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="session/select-context" options={{ headerShown: false }} />
      <Stack.Screen name="session/scan" options={{ headerShown: false }} />
      <Stack.Screen name="delegations" options={{ headerShown: false }} />
      <Stack.Screen name="enrollment" options={{ headerShown: false }} />
      <Stack.Screen name="people" options={{ headerShown: false }} />
      <Stack.Screen name="academics" options={{ headerShown: false }} />
    </Stack>
  );
}
