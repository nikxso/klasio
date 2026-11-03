import React from 'react';
import { Stack } from 'expo-router';

export default function StudentStackLayout() {
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
