import React from 'react';
import { View, Text, StyleSheet, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldAlert, ArrowLeft } from 'lucide-react-native';
import { Colors, Radii } from '@/theme/tokens';

export interface AccessRestrictedViewProps {
  title?: string;
  message?: string;
  requiredCapability?: string;
  onBack?: () => void;
  fullScreen?: boolean;
}

export function AccessRestrictedView({
  title = 'Access Restricted',
  message = 'Your currently assigned roles and permissions do not permit access to this screen or configuration.',
  requiredCapability,
  onBack,
  fullScreen = true,
}: AccessRestrictedViewProps) {
  const router = useRouter();

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      try {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/');
        }
      } catch {
        router.replace('/');
      }
    }
  };

  return (
    <View
      style={[styles.container, fullScreen && styles.fullScreen]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      accessibilityLabel={`${title}. ${message}`}
    >
      <View style={styles.card}>
        <View style={styles.iconCircle} accessibilityElementsHidden>
          <ShieldAlert size={36} color={Colors.rose} />
        </View>

        <View style={styles.badge} accessibilityElementsHidden>
          <Text style={styles.badgeText}>SECURITY & CAPABILITY GUARD</Text>
        </View>

        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>

        <Text style={styles.message}>{message}</Text>

        {requiredCapability && (
          <View style={styles.capabilityBox}>
            <Text style={styles.capabilityLabel}>Required Capability:</Text>
            <Text style={styles.capabilityValue}>{requiredCapability}</Text>
          </View>
        )}

        <Pressable
          style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.85 }]}
          onPress={handleBack}
          accessibilityRole="button"
          accessibilityLabel="Go back to previous screen"
          accessibilityHint="Returns you safely to the authorized dashboard"
        >
          <ArrowLeft size={18} color="#ffffff" />
          <Text style={styles.backButtonText}>Return to Authorized Screen</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullScreen: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  card: {
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    padding: 24,
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.line,
    shadowColor: Colors.ink,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 3,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#fff1f2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#ffe4e6',
  },
  badge: {
    backgroundColor: '#fee2e2',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: Radii.pill,
    marginBottom: 12,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.rose,
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.ink,
    marginBottom: 8,
    textAlign: 'center',
  },
  message: {
    fontSize: 13,
    color: Colors.soft,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 16,
    paddingHorizontal: 8,
  },
  capabilityBox: {
    backgroundColor: '#f8fafc',
    borderRadius: Radii.card,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    paddingVertical: 8,
    paddingHorizontal: 12,
    width: '100%',
    marginBottom: 20,
    alignItems: 'center',
  },
  capabilityLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.soft,
    textTransform: 'uppercase',
  },
  capabilityValue: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.forest,
    marginTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.forest,
    borderRadius: Radii.button,
    paddingVertical: 12,
    paddingHorizontal: 20,
    width: '100%',
    minHeight: 48,
  },
  backButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
});
