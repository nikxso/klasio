import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  ScanFace,
  Bell,
  ShieldCheck,
  HelpCircle,
  LogOut,
  ChevronRight,
} from 'lucide-react-native';

import { Screen, Card, Chip, IconBubble, Avatar } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';

export default function StudentProfileScreen() {
  const router = useRouter();

  const handleSignOut = () => {
    router.replace('/');
  };

  return (
    <Screen scrollable>
      <View style={styles.headerBlock}>
        <Avatar name="Aarav Sharma" size={76} />
        <Text style={styles.userName}>Aarav Sharma</Text>
        <Text style={styles.userSub}>CSE · Section 3A · 21CS037</Text>
        <Chip tone="forest" style={styles.cohortChip}>
          Cohort 2026–27 · 3rd Year
        </Chip>
      </View>

      <Text style={styles.sectionHeader}>Biometric Authentication</Text>
      <Card style={styles.cardGroup}>
        <Pressable
          onPress={() => router.push('/(student)/enrollment' as any)}
          style={({ pressed }) => [
            styles.infoRow,
            pressed && { opacity: 0.7 },
          ]}
        >
          <IconBubble icon={ScanFace} tone="lilac" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Face ID</Text>
            <Text style={styles.infoSubtitle}>Active · Template Verified</Text>
          </View>
          <Chip tone="forest">Active</Chip>
        </Pressable>
      </Card>

      <Text style={styles.sectionHeader}>General & Privacy</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={ShieldCheck} tone="forest" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Biometric Privacy Boundary</Text>
            <Text style={styles.infoSubtitle}>
              No video ever leaves the classroom. Only encrypted 128D mathematical patterns are retained.
            </Text>
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <IconBubble icon={Bell} tone="apricot" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Attendance Notifications</Text>
            <Text style={styles.infoSubtitle}>Alerts for sessions below 75% threshold</Text>
          </View>
          <Chip tone="forest">Enabled</Chip>
        </View>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <IconBubble icon={HelpCircle} tone="soft" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Attendance Regulations</Text>
            <Text style={styles.infoSubtitle}>Standard 75.0% collegiate requirement</Text>
          </View>
          <ChevronRight size={18} color={Colors.soft} />
        </View>
      </Card>

      <Pressable
        onPress={handleSignOut}
        style={({ pressed }) => [
          styles.signOutButton,
          pressed && { opacity: 0.8 },
        ]}
      >
        <LogOut size={18} color={Colors.rose} />
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerBlock: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  userName: {
    fontSize: 22,
    fontWeight: '700',
    color: Colors.ink,
    marginTop: 12,
  },
  userSub: {
    fontSize: 14,
    color: Colors.soft,
    marginTop: 4,
  },
  cohortChip: {
    marginTop: 8,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  cardGroup: {
    padding: 14,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  infoCol: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
  },
  infoSubtitle: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.line,
    marginVertical: 12,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 28,
    marginBottom: 20,
    paddingVertical: 14,
    borderRadius: Radii.button,
    borderWidth: 1,
    borderColor: '#fbd0cc',
    backgroundColor: '#fff5f5',
  },
  signOutText: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.rose,
  },
});
