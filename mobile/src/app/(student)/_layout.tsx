import React from 'react';
import { Stack } from 'expo-router';

export default function StudentStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false, animation: 'fade' }} />
      <Stack.Screen name="subject/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="enrollment" options={{ headerShown: false }} />
    </Stack>
  );
}
