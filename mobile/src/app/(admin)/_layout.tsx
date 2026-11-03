import React from 'react';
import { Stack } from 'expo-router';

export default function AdminStackLayout() {
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
