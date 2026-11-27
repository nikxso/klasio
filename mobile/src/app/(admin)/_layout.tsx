import React, { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '@/hooks/useSession';
import { AccessRestrictedView } from '@/components/ui/kit';

export default function AdminStackLayout() {
  const router = useRouter();
  const { user, isAuthenticated, isLoaded } = useSession();

  useEffect(() => {
    if (isLoaded && (!isAuthenticated || !user)) {
      router.replace('/');
    }
  }, [isLoaded, isAuthenticated, user]);

  if (user?.role?.toUpperCase() === 'STUDENT') {
    return (
      <AccessRestrictedView
        title="Admin Console Restricted"
        message="Student accounts cannot access administrative consoles or institutional configurations."
        requiredCapability="institution.manage or campus.manage"
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
    </Stack>
  );
}
