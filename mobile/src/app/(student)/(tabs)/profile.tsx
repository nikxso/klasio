import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  RefreshControl,
} from 'react-native';
import { useRouter, useNavigation, useFocusEffect } from 'expo-router';
import {
  ScanFace,
  Bell,
  ShieldCheck,
  HelpCircle,
  LogOut,
  ChevronRight,
} from 'lucide-react-native';

import { Screen, Card, Chip, IconBubble, Avatar, Sheet, Button } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import { Brand } from '@/constants/brand';
import { API_BASE_URL } from '@/config/api';
import { SessionStore, AuthUser } from '@/storage/sessionStore';

export default function StudentProfileScreen() {
  const router = useRouter();
  const navigation = useNavigation<any>();
  const [user, setUser] = useState<AuthUser | null>(SessionStore.getUser());
  const [showSignOutSheet, setShowSignOutSheet] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [cacheBuster, setCacheBuster] = useState(Date.now());

  useEffect(() => {
    async function initUser() {
      const stored = SessionStore.getUser() || (await SessionStore.initFromStorage())?.user;
      if (stored) {
        setUser(stored);
      }
      setCacheBuster(Date.now());
    }
    initUser();

    // Subscribe to SessionStore real-time updates (e.g. immediately upon enrollment)
    const unsub = SessionStore.subscribe((session) => {
      if (session?.user) {
        setUser(session.user);
        setCacheBuster(Date.now());
      }
    });
    return unsub;
  }, []);

  useFocusEffect(
    useCallback(() => {
      const stored = SessionStore.getUser();
      if (stored) {
        setUser(stored);
      }
      setCacheBuster(Date.now());
    }, [])
  );

  const studentName = user?.fullName || 'Enrolled Student';
  const studentId = user?.id;
  const studentRoll = user?.institutionalId || 'STUDENT';
  const isRegistered = user?.faceRegistrationState === 'REGISTERED';

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

  return (
    <Screen
      scrollable
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => {
            const stored = SessionStore.getUser();
            if (stored) setUser(stored);
            setCacheBuster(Date.now());
          }}
          colors={[Colors.primary, Colors.forest]}
        />
      }
    >
      <View style={styles.headerBlock}>
        <Avatar
          name={studentName}
          userId={studentId}
          version={cacheBuster}
          photoUrl={studentId ? `${API_BASE_URL}/api/v1/users/${studentId}/profile-photo?t=${cacheBuster}` : null}
          size={76}
        />
        <Text style={styles.userName}>{studentName}</Text>
        <Text style={styles.userSub}>{studentRoll} · Enrolled Student</Text>
        <Chip tone="forest" style={styles.cohortChip}>
          Active Academic Enrollment
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
          <IconBubble icon={ScanFace} tone={isRegistered ? 'forest' : 'lilac'} size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Face ID</Text>
            <Text style={styles.infoSubtitle}>
              {isRegistered ? 'Active · Template Verified' : 'Not configured · Tap to enroll'}
            </Text>
          </View>
          <Chip tone={isRegistered ? 'forest' : 'amber'}>
            {isRegistered ? 'Active' : 'Not Set'}
          </Chip>
        </Pressable>
      </Card>

      <Text style={styles.sectionHeader}>General & Privacy</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={ShieldCheck} tone="forest" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Biometric Privacy Boundary</Text>
            <Text style={styles.infoSubtitle}>
              No video or raw photographs ever leave the device. Only mathematically verified feature embeddings (EdgeFace-XS 512D) are retained.
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
        onPress={() => setShowSignOutSheet(true)}
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
            You will be returned to the login screen and will need your institutional ID to sign back in.
          </Text>
          <View style={{ width: '100%', gap: 10 }}>
            <Button
              tone="rose"
              disabled={isSigningOut}
              onPress={handleConfirmSignOut}
            >
              {isSigningOut ? 'Signing out…' : 'Sign Out'}
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
