import React from 'react';
import { Stack } from 'expo-router';

export default function FacultyStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false, animation: 'fade' }} />
      <Stack.Screen name="section/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="session/scan" options={{ headerShown: false }} />
      <Stack.Screen name="delegations" options={{ headerShown: false }} />
      <Stack.Screen name="enrollment" options={{ headerShown: false }} />
    </Stack>
  );
}
