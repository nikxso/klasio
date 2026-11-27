import React from 'react';
import { Stack, Redirect } from 'expo-router';
import { useSession } from '@/hooks/useSession';

export default function StudentStackLayout() {
  const { isAuthenticated, isLoaded } = useSession();

  if (!isLoaded) {
    return null;
  }

  if (!isAuthenticated) {
    return <Redirect href="/" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'none',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false, animation: 'none' }} />
      <Stack.Screen name="subject/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="enrollment" options={{ headerShown: false }} />
    </Stack>
  );
}
