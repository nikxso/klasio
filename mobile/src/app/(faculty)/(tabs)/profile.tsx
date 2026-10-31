import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  User,
  ShieldCheck,
  Smartphone,
  Cpu,
  CloudCheck,
  RefreshCw,
  LogOut,
  ChevronRight,
  HelpCircle,
  Clock,
  CheckCircle2,
} from 'lucide-react-native';

import { Screen, Card, Chip, IconBubble, Avatar } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { AttendanceSyncWorker } from '@/storage/syncWorker';

export default function FacultyProfileScreen() {
  const router = useRouter();
  const [pendingQueueCount, setPendingQueueCount] = useState<number>(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    async function loadQueueStatus() {
      try {
        const items = await AttendanceSyncWorker.getPendingQueueItems();
        setPendingQueueCount(items.length);
      } catch {
        setPendingQueueCount(0);
      }
    }
    loadQueueStatus();
  }, []);

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      await AttendanceSyncWorker.processPendingQueue();
      const items = await AttendanceSyncWorker.getPendingQueueItems();
      setPendingQueueCount(items.length);
    } catch {
      // Offline fallback
    } finally {
      setSyncing(false);
    }
  };

  const handleSignOut = () => {
    router.replace('/');
  };

  return (
    <Screen scrollable>
      <View style={styles.headerBlock}>
        <Avatar name="Dr. Lakshmi Iyer" size={72} />
        <Text style={styles.userName}>Dr. Lakshmi Iyer</Text>
        <Text style={styles.userRole}>Associate Professor · Computer Science</Text>
        <Chip tone="forest" style={styles.badgeChip}>
          Staff ID: FAC-0142
        </Chip>
      </View>

      <Text style={styles.sectionHeader}>Biometric Perception & Device</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={Cpu} tone="lilac" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Edge Perception Engine</Text>
            <Text style={styles.infoSubtitle}>MobileFaceNet 128D · v2.4-live</Text>
          </View>
          <Chip tone="forest">Active</Chip>
        </View>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <IconBubble icon={Smartphone} tone="forest" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Device Authorization</Text>
            <Text style={styles.infoSubtitle}>Authorized for Dept Roster Scopes</Text>
          </View>
          <Chip tone="forest">Verified</Chip>
        </View>
      </Card>

      <Text style={styles.sectionHeader}>Sync & Offline Storage</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={Clock} tone={pendingQueueCount > 0 ? 'amber' : 'forest'} size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Offline Queue</Text>
            <Text style={styles.infoSubtitle}>
              {pendingQueueCount === 0
                ? 'All finalized attendance synced'
                : `${pendingQueueCount} records waiting to sync`}
            </Text>
          </View>
          <Pressable
            onPress={handleSyncNow}
            disabled={syncing}
            style={({ pressed }) => [
              styles.syncButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <RefreshCw size={16} color={Colors.forest} />
          </Pressable>
        </View>
      </Card>

      <Text style={styles.sectionHeader}>Data Privacy & Standards</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={ShieldCheck} tone="forest" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Biometric Privacy Boundary</Text>
            <Text style={styles.infoSubtitle}>Zero raw classroom video retained or uploaded</Text>
          </View>
        </View>

        <View style={styles.divider} />

        <Pressable
          onPress={() => router.push('/(faculty)/delegations')}
          style={({ pressed }) => [
            styles.actionRow,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.actionRowText}>Manage Substitute Delegations</Text>
          <ChevronRight size={18} color={Colors.soft} />
        </Pressable>
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
  userRole: {
    fontSize: 14,
    color: Colors.soft,
    marginTop: 4,
  },
  badgeChip: {
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
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  actionRowText: {
    fontSize: 14,
    fontWeight: '500',
    color: Colors.forest,
  },
  syncButton: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: Colors.forest50,
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
