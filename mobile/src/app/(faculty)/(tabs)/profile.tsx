import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Alert,
} from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
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

import { Screen, Card, Chip, IconBubble, Avatar, Sheet, Button } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { AttendanceSyncWorker } from '@/storage/syncWorker';
import { SessionStore, AuthUser } from '@/storage/sessionStore';
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import { Brand } from '@/constants/brand';
import { API_BASE_URL } from '@/config/api';

export default function FacultyProfileScreen() {
  const router = useRouter();
  const navigation = useNavigation<any>();
  const [user, setUser] = useState<AuthUser | null>(SessionStore.getUser());
  const [pendingQueueCount, setPendingQueueCount] = useState<number>(0);
  const [syncing, setSyncing] = useState(false);
  const [showSignOutSheet, setShowSignOutSheet] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [cacheBuster, setCacheBuster] = useState(Date.now());

  useEffect(() => {
    async function initUserAndQueue() {
      const stored = SessionStore.getUser() || (await SessionStore.initFromStorage())?.user;
      if (stored) {
        setUser(stored);
      }
      setCacheBuster(Date.now());
      try {
        const items = await AttendanceSyncWorker.getPendingQueueItems();
        setPendingQueueCount(items.length);
      } catch {
        setPendingQueueCount(0);
      }
    }
    initUserAndQueue();
  }, []);

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const session = await SessionStore.initFromStorage();
      await AttendanceSyncWorker.processPendingQueue(undefined, session?.token || SessionStore.getToken());
      const items = await AttendanceSyncWorker.getPendingQueueItems();
      setPendingQueueCount(items.length);
    } catch {
      // Offline fallback
    } finally {
      setSyncing(false);
    }
  };

  const handleSignOutPress = async () => {
    try {
      const count = await SessionStore.hasPendingSync();
      setPendingQueueCount(count);
    } catch (_) {}
    setShowSignOutSheet(true);
  };

  const handleConfirmSignOut = async () => {
    setIsSigningOut(true);
    try {
      await SessionStore.clearSession(true);
      setShowSignOutSheet(false);
      try {
        router.dismissAll();
      } catch (_) {}
      router.replace('/');
    } catch (e) {
      console.warn('Sign out error:', e);
      router.replace('/');
    } finally {
      setIsSigningOut(false);
    }
  };

  const facultyName = user?.fullName || 'Dr. Lakshmi Iyer';
  const facultyStaffId = user?.institutionalId || 'FAC-0142';
  const facultyId = user?.id;

  return (
    <Screen scrollable>
      <View style={styles.headerBlock}>
        <Avatar
          name={facultyName}
          userId={facultyId}
          photoUrl={facultyId ? `${API_BASE_URL}/api/v1/users/${facultyId}/profile-photo?t=${cacheBuster}` : null}
          size={72}
        />
        <Text style={styles.userName}>{facultyName}</Text>
        <Text style={styles.userRole}>Faculty · Computer Science</Text>
        <Chip tone="forest" style={styles.badgeChip}>
          Staff ID: {facultyStaffId}
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
              {syncing
                ? 'Syncing your changes…'
                : pendingQueueCount === 0
                ? 'Everything is up to date.'
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
          onPress={() => router.push('/(faculty)/delegations' as any)}
          style={({ pressed }) => [
            styles.actionRow,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.actionRowText}>Manage Substitute Delegations</Text>
          <ChevronRight size={18} color={Colors.soft} />
        </Pressable>
      </Card>

      <Text style={styles.sectionHeader}>About {Brand.name}</Text>
      <Card style={styles.cardGroup}>
        <View style={{ marginBottom: 8 }}>
          <KlasioLogo variant="lockup" size={20} />
        </View>
        <Text style={{ fontSize: 13, color: Colors.ink, fontWeight: '600', marginBottom: 2 }}>
          {Brand.descriptor}
        </Text>
        <Text style={{ fontSize: 12, color: Colors.soft, lineHeight: 17, marginBottom: 8 }}>
          {Brand.description}
        </Text>
        <Text style={{ fontSize: 11, color: Colors.soft }}>
          {Brand.academicTitle}
        </Text>
      </Card>

      <Pressable
        onPress={handleSignOutPress}
        style={({ pressed }) => [
          styles.signOutButton,
          pressed && { opacity: 0.8 },
        ]}
      >
        <LogOut size={18} color={Colors.rose} />
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>

      {/* Sign Out Confirmation Sheet */}
      <Sheet visible={showSignOutSheet} onClose={() => setShowSignOutSheet(false)}>
        <View style={{ alignItems: 'center', paddingVertical: 12 }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff5f5', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
            <LogOut size={26} color={Colors.rose} />
          </View>
          <Text style={{ fontSize: 18, fontWeight: '700', color: Colors.ink, marginBottom: 6 }}>
            Sign out of Klasio?
          </Text>
          <Text style={{ fontSize: 13, color: Colors.soft, textAlign: 'center', paddingHorizontal: 20, marginBottom: 20 }}>
            {pendingQueueCount > 0
              ? `You have ${pendingQueueCount} offline attendance record(s) queued for synchronization. Signing out will preserve these records on this device.`
              : 'You will be returned to the login screen and will need your staff credentials to sign back in.'}
          </Text>
          <View style={{ width: '100%', gap: 10 }}>
            <Button
              tone="rose"
              disabled={isSigningOut}
              onPress={handleConfirmSignOut}
            >
              {isSigningOut ? 'Signing out…' : (pendingQueueCount > 0 ? 'Sign Out & Preserve Records' : 'Sign Out')}
            </Button>
            <Button
              tone="soft"
              disabled={isSigningOut}
              onPress={() => setShowSignOutSheet(false)}
            >
              Cancel
            </Button>
          </View>
        </View>
      </Sheet>
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
