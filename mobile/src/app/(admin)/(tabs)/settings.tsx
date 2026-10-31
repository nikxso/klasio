import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  ScanFace,
  Percent,
  ShieldCheck,
  Bell,
  HelpCircle,
  LogOut,
  RefreshCw,
  Smartphone,
  ChevronRight,
  CheckCircle2,
} from 'lucide-react-native';

import { Screen, Card, Chip, IconBubble, Avatar, Sheet, Button } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import { Brand } from '@/constants/brand';

const DEVICES = [
  { name: 'Dr. Lakshmi’s phone', ok: true, seen: '2 min ago' },
  { name: 'Prof. Rahul’s phone', ok: true, seen: '1 hr ago' },
  { name: 'Dr. Fatima’s tablet', ok: true, seen: 'Yesterday' },
];

export default function AdminSettingsScreen() {
  const router = useRouter();
  const [facesSheet, setFacesSheet] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [devices, setDevices] = useState(DEVICES);

  const handlePushUpdate = () => {
    setUpdating(true);
    setTimeout(() => {
      setDevices((prev) => prev.map((d) => ({ ...d, ok: true, seen: 'Just now' })));
      setUpdating(false);
    }, 1200);
  };

  const handleSignOut = () => {
    router.replace('/');
  };

  return (
    <Screen scrollable>
      <View style={styles.headerBlock}>
        <Avatar name="Meera Nair" size={76} />
        <Text style={styles.userName}>Meera Nair</Text>
        <Text style={styles.userSub}>Administrator · Academic Dean Office</Text>
        <Chip tone="forest" style={styles.adminChip}>
          ADM-0007 · Full Permissions
        </Chip>
      </View>

      <Text style={styles.sectionHeader}>Attendance Policies</Text>
      <Card style={styles.cardGroup}>
        <Pressable
          onPress={() => setFacesSheet(true)}
          style={({ pressed }) => [
            styles.infoRow,
            pressed && { opacity: 0.7 },
          ]}
        >
          <IconBubble icon={ScanFace} tone="lilac" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Face Recognition Baseline</Text>
            <Text style={styles.infoSubtitle}>
              MobileFaceNet 128D · v2.4 · {devices.length} faculty devices
            </Text>
          </View>
          <ChevronRight size={18} color={Colors.soft} />
        </Pressable>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <IconBubble icon={Percent} tone="apricot" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Minimum Attendance Threshold</Text>
            <Text style={styles.infoSubtitle}>Standard collegiate policy</Text>
          </View>
          <Chip tone="amber">75.0%</Chip>
        </View>
      </Card>

      <Text style={styles.sectionHeader}>Privacy & Audit Trail</Text>
      <Card style={styles.cardGroup}>
        <View style={styles.infoRow}>
          <IconBubble icon={ShieldCheck} tone="forest" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>Data Privacy Guarantee</Text>
            <Text style={styles.infoSubtitle}>
              Zero raw video retained or uploaded. Immutable amendment audits.
            </Text>
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.infoRow}>
          <IconBubble icon={Bell} tone="apricot" size={40} />
          <View style={styles.infoCol}>
            <Text style={styles.infoTitle}>System Broadcasts</Text>
            <Text style={styles.infoSubtitle}>Automated shortage warnings enabled</Text>
          </View>
          <Chip tone="forest">Active</Chip>
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
        onPress={handleSignOut}
        style={({ pressed }) => [
          styles.signOutButton,
          pressed && { opacity: 0.8 },
        ]}
      >
        <LogOut size={18} color={Colors.rose} />
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>

      {/* Face Recognition Device Sync Sheet */}
      <Sheet visible={facesSheet} onClose={() => setFacesSheet(false)}>
        <Text style={styles.sheetTitle}>Face Recognition Version</Text>
        <Text style={styles.sheetSubtitle}>
          Keep every faculty device on the verified model baseline.
        </Text>

        <Card style={styles.modelCard}>
          <IconBubble icon={ScanFace} tone="lilac" size={40} />
          <View style={styles.modelTextCol}>
            <Text style={styles.modelTitle}>Version 2.4 (MobileFaceNet 128D)</Text>
            <Text style={styles.modelSub}>Calibrated Cosine Threshold: 0.65</Text>
          </View>
          <Chip tone="forest">Live</Chip>
        </Card>

        <Text style={styles.devicesHeader}>Faculty Devices</Text>
        <View style={styles.devicesList}>
          {devices.map((d) => (
            <View key={d.name} style={styles.deviceRow}>
              <IconBubble icon={Smartphone} tone={d.ok ? 'forest' : 'amber'} size={36} />
              <View style={styles.deviceTextCol}>
                <Text style={styles.deviceName}>{d.name}</Text>
                <Text style={styles.deviceSeen}>Seen {d.seen}</Text>
              </View>
              <Chip tone={d.ok ? 'forest' : 'amber'}>
                {d.ok ? 'Up to date' : 'Needs update'}
              </Chip>
            </View>
          ))}
        </View>

        <Button
          onPress={handlePushUpdate}
          disabled={updating}
          style={styles.pushUpdateButton}
        >
          {updating ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <RefreshCw size={16} color="#ffffff" />
          )}
          <Text style={styles.pushUpdateText}>
            {updating ? 'Broadcasting...' : 'Send update to all phones'}
          </Text>
        </Button>
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
  adminChip: {
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
  sheetTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.ink,
  },
  sheetSubtitle: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 4,
    marginBottom: 16,
  },
  modelCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    backgroundColor: Colors.forest50,
  },
  modelTextCol: {
    flex: 1,
  },
  modelTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.forest,
  },
  modelSub: {
    fontSize: 11,
    color: Colors.soft,
    marginTop: 2,
  },
  devicesHeader: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
    marginTop: 16,
    marginBottom: 8,
  },
  devicesList: {
    gap: 8,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
  },
  deviceTextCol: {
    flex: 1,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
  },
  deviceSeen: {
    fontSize: 11,
    color: Colors.soft,
  },
  pushUpdateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 20,
  },
  pushUpdateText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
});
