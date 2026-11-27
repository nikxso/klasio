import React, { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '@/hooks/useSession';

export default function StudentStackLayout() {
  const router = useRouter();
  const { isAuthenticated, isLoaded } = useSession();

  useEffect(() => {
    if (isLoaded && !isAuthenticated) {
      router.replace('/');
    }
  }, [isLoaded, isAuthenticated]);

  if (!isLoaded || !isAuthenticated) {
    return null;
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
