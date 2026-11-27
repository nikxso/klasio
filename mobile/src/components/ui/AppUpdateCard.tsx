import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { RefreshCw, Smartphone, ArrowDownCircle } from 'lucide-react-native';
import { Card, Chip, IconBubble, Button } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import {
  checkForAppUpdates,
  getAppUpdateState,
  applyUpdateAndReload,
  subscribeUpdateEvents,
  AppUpdateDiagnostics,
} from '@/services/updateService';

export function AppUpdateCard() {
  const [diagnostics, setDiagnostics] = useState<AppUpdateDiagnostics>(getAppUpdateState());
  const [checking, setChecking] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setDiagnostics(getAppUpdateState());
    const unsub = subscribeUpdateEvents((state) => {
      setUpdatePending(state.isPending);
      setDownloading(state.status === 'DOWNLOADING');
      setDiagnostics(getAppUpdateState());
    });
    return unsub;
  }, []);

  const handleManualCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const res = await checkForAppUpdates(false);
      setDiagnostics(getAppUpdateState());
      if (res?.updateAvailable) {
        setUpdatePending(true);
      }
    } finally {
      setChecking(false);
    }
  };

  const handleApplyNow = async () => {
    await applyUpdateAndReload();
  };

  const updateLabel = diagnostics.updateId
    ? `OTA: ${diagnostics.updateId.slice(0, 8)}`
    : diagnostics.isEmbeddedLaunch
    ? (diagnostics.isEnabled ? 'Base APK (OTA Ready)' : 'Base APK')
    : 'Local Build';

  const tone = diagnostics.updateId ? 'forest' : diagnostics.isEnabled ? 'lilac' : 'soft';

  return (
    <Card style={styles.card}>
      <View style={styles.headerRow}>
        <IconBubble icon={Smartphone} tone={tone} size={40} />
        <View style={styles.titleCol}>
          <Text style={styles.title}>System & App Updates</Text>
          <Text style={styles.subtitle}>
            Klasio v{diagnostics.runtimeVersion || '1.0.0'} · {diagnostics.channel || 'production'}
          </Text>
        </View>
        <Chip tone={tone}>{updateLabel}</Chip>
      </View>

      <View style={styles.divider} />

      <View style={styles.infoRow}>
        <View style={styles.infoCol}>
          <Text style={styles.statusLabel}>Update Channel Status</Text>
          <Text style={styles.statusValue}>
            {updatePending
              ? 'New update ready! Tap below to restart.'
              : downloading
              ? 'Downloading latest update in background...'
              : diagnostics.isEnabled
              ? 'Connected to Klasio Azure Cloud OTA'
              : 'Standalone base binary (OTA inactive)'}
          </Text>
        </View>

        {updatePending ? (
          <Button
            tone="forest"
            onPress={handleApplyNow}
            style={styles.actionBtn}
            icon={<ArrowDownCircle size={15} color="#FFFFFF" />}
          >
            Restart
          </Button>
        ) : (
          <Pressable
            onPress={handleManualCheck}
            disabled={checking}
            style={({ pressed }) => [
              styles.checkButton,
              pressed && { opacity: 0.7 },
              checking && { opacity: 0.5 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Check for updates"
          >
            {checking ? (
              <ActivityIndicator size="small" color={Colors.forest} />
            ) : (
              <View style={styles.buttonInner}>
                <RefreshCw size={13} color={Colors.forest} />
                <Text style={styles.checkButtonText}>Check Now</Text>
              </View>
            )}
          </Pressable>
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: Radii.lg || 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#ECEAE2',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  titleCol: {
    flex: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.ink,
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: '#ECEAE2',
    marginVertical: 14,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  infoCol: {
    flex: 1,
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.soft,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statusValue: {
    fontSize: 13,
    fontWeight: '500',
    color: Colors.ink,
    marginTop: 2,
  },
  checkButton: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: Radii.md || 10,
    backgroundColor: '#EAF3EF',
    borderWidth: 1,
    borderColor: '#C3DFD3',
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  checkButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.forest,
  },
  actionBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    minHeight: 34,
  },
});
