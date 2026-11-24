import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  GraduationCap,
  Presentation,
  ShieldCheck,
  Eye,
  EyeOff,
  AlertCircle,
} from 'lucide-react-native';

import { Colors, Radii } from '@/theme/tokens';
import { Button } from '@/components/ui/kit';
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import { Brand } from '@/constants/brand';
import { API_BASE_URL } from '@/config/api';
import { SessionStore } from '@/storage/sessionStore';

export type RoleKey = 'student' | 'faculty' | 'admin';

interface RoleOption {
  key: RoleKey;
  label: string;
  icon: typeof GraduationCap;
  defaultId: string;
}

const ROLES: RoleOption[] = [
  {
    key: 'student',
    label: 'Student',
    icon: GraduationCap,
    defaultId: 'S3',
  },
  {
    key: 'faculty',
    label: 'Faculty',
    icon: Presentation,
    defaultId: 'prof_alan',
  },
  {
    key: 'admin',
    label: 'Admin',
    icon: ShieldCheck,
    defaultId: 'admin_meera',
  },
];

export default function LoginScreen() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const handleAutofill = (roleKey: RoleKey) => {
    setAuthError(null);
    const roleConfig = ROLES.find((r) => r.key === roleKey)!;
    setIdentifier(roleConfig.defaultId);
    setPassword('password');
  };

  const handleSignIn = async () => {
    if (!identifier.trim()) {
      setAuthError('Please enter your Institutional ID.');
      return;
    }
    if (!password) {
      setAuthError('Please enter your password.');
      return;
    }

    setLoading(true);
    setAuthError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: identifier.trim(), password }),
      });
      if (res.ok) {
        const data = await res.json();
        await SessionStore.setSession({
          token: data.access_token,
          user: {
            id: data.user.id,
            institutionalId: data.user.institutional_id,
            email: data.user.email,
            fullName: data.user.full_name,
            role: data.user.role,
            faceRegistrationState: data.user.face_registration_state,
          },
        });
        setLoading(false);
        if (data.user.role === 'STUDENT') {
          router.replace('/(student)' as any);
        } else if (data.user.role === 'ADMIN') {
          router.replace('/(admin)' as any);
        } else {
          router.replace('/(faculty)' as any);
        }
        return;
      } else {
        let errMsg = 'Invalid credentials. Please verify your ID and password.';
        try {
          const errJson = await res.json();
          if (errJson?.detail) errMsg = errJson.detail;
        } catch (_) {}
        setAuthError(errMsg);
        setLoading(false);
        return;
      }
    } catch (e) {
      console.warn('[AUTH] Offline/connection error during login:', e);
      const cached = await SessionStore.initFromStorage();
      if (cached?.user) {
        setLoading(false);
        if (cached.user.role === 'STUDENT') {
          router.replace('/(student)' as any);
        } else if (cached.user.role === 'ADMIN') {
          router.replace('/(admin)' as any);
        } else {
          router.replace('/(faculty)' as any);
        }
        return;
      }
      setAuthError('Cannot connect to authentication server and no active offline session exists.');
      setLoading(false);
      return;
    }
  };

  const insets = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardContainer}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: Math.max(insets.bottom, 24) + 20 },
          ]}
          bounces={false}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Forest Hero Header */}
          <View style={[styles.heroSection, { paddingTop: insets.top + 16 }]}>
            {/* Background Decorative Circles */}
            <View style={styles.heroFloatApricot} />
            <View style={styles.heroFloatWhite} />

            <View style={styles.heroSafeArea}>
              {/* Klasio Brand Mark */}
              <KlasioLogo
                variant="white-mark"
                size={54}
                containerStyle={styles.logoContainer}
              />

              {/* Title Header */}
              <Text style={styles.heroTitle}>
                Welcome to{'\n'}
                <Text style={styles.heroTitleBrand}>{Brand.name}</Text>
              </Text>

              {/* Subtitle */}
              <Text style={styles.heroSubtitle}>
                {Brand.descriptor}
              </Text>
            </View>
          </View>

          {/* Form Content Area */}
          <View style={styles.formSection}>
            <Text style={styles.formTitle}>Sign In</Text>
            <Text style={styles.formSubtitle}>Access your attendance and courses</Text>

            {/* Error Banner */}
            {authError && (
              <View style={styles.errorBanner}>
                <AlertCircle size={18} color="#dc2626" />
                <Text style={styles.errorBannerText}>{authError}</Text>
              </View>
            )}

            {/* Identifier Input */}
            <View style={styles.fieldContainer}>
              <Text style={styles.fieldLabel}>Institutional ID</Text>
              <TextInput
                style={styles.input}
                value={identifier}
                onChangeText={setIdentifier}
                placeholder="Enter Institutional ID"
                placeholderTextColor={Colors.soft}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            {/* Password Input */}
            <View style={styles.fieldContainer}>
              <Text style={styles.fieldLabel}>Password</Text>
              <View style={styles.passwordRow}>
                <TextInput
                  style={styles.passwordInput}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  placeholder="Enter password"
                  placeholderTextColor={Colors.soft}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Pressable
                  onPress={() => setShowPassword((prev) => !prev)}
                  hitSlop={10}
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  style={styles.eyeButton}
                >
                  {showPassword ? (
                    <EyeOff size={18} color={Colors.soft} />
                  ) : (
                    <Eye size={18} color={Colors.soft} />
                  )}
                </Pressable>
              </View>
            </View>

            {/* Submit Button */}
            <View style={styles.submitContainer}>
              <Button
                variant="primary"
                disabled={loading}
                onPress={handleSignIn}
              >
                {loading ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  'Sign in'
                )}
              </Button>
            </View>

            {/* Debug Quick Autofill Tray */}
            <View style={styles.autofillSection}>
              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>Quick Autofill (Debug)</Text>
                <View style={styles.dividerLine} />
              </View>

              <View style={styles.autofillGrid}>
                {ROLES.map((role) => {
                  const IconComponent = role.icon;
                  const isCurrent = identifier === role.defaultId;

                  return (
                    <Pressable
                      key={role.key}
                      onPress={() => handleAutofill(role.key)}
                      style={[
                        styles.autofillCard,
                        isCurrent ? styles.autofillCardActive : styles.autofillCardInactive,
                      ]}
                      accessibilityLabel={`Autofill ${role.label}`}
                    >
                      <IconComponent
                        size={18}
                        color={isCurrent ? Colors.forest : Colors.soft}
                      />
                      <Text
                        style={[
                          styles.autofillLabel,
                          isCurrent ? styles.autofillLabelActive : styles.autofillLabelInactive,
                        ]}
                      >
                        {role.label}
                      </Text>
                      <Text style={styles.autofillIdText}>{role.defaultId}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Developer Lab Shortcut */}
            <Pressable
              onPress={() => router.push('/lab/perception')}
              style={styles.labLink}
            >
              <Text style={styles.labLinkText}>
                🔬 Open Perception Diagnostic Lab
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  keyboardContainer: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  heroSection: {
    backgroundColor: Colors.forest,
    borderBottomLeftRadius: 40,
    borderBottomRightRadius: 40,
    overflow: 'hidden',
    paddingHorizontal: 28,
    paddingTop: 12,
    paddingBottom: 32,
    minHeight: 270,
    position: 'relative',
  },
  heroFloatApricot: {
    position: 'absolute',
    top: -40,
    right: -40,
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: 'rgba(240, 168, 104, 0.35)',
  },
  heroFloatWhite: {
    position: 'absolute',
    bottom: 24,
    right: 50,
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  heroSafeArea: {
    zIndex: 1,
  },
  logoContainer: {
    marginBottom: 16,
  },
  heroTitle: {
    fontFamily: 'ChangaOne-Regular',
    fontSize: 40,
    lineHeight: 46,
    color: '#ffffff',
    letterSpacing: -0.5,
  },
  heroTitleBrand: {
    fontFamily: 'ChangaOne-Regular',
    color: Colors.apricot,
  },
  heroSubtitle: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.75)',
    marginTop: 8,
  },
  formSection: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 32,
  },
  formTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: Colors.ink,
    marginBottom: 4,
  },
  formSubtitle: {
    fontSize: 14,
    color: Colors.soft,
    marginBottom: 20,
  },
  fieldContainer: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 12,
    color: Colors.soft,
    marginBottom: 6,
    fontWeight: '500',
  },
  input: {
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.line,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: Colors.ink,
    fontWeight: '500',
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.line,
    borderRadius: 16,
    paddingHorizontal: 16,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 15,
    color: Colors.ink,
  },
  eyeButton: {
    padding: 8,
  },
  submitContainer: {
    marginTop: 8,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: Radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
    gap: 8,
  },
  errorBannerText: {
    flex: 1,
    fontSize: 13,
    color: '#b91c1c',
    lineHeight: 18,
  },
  autofillSection: {
    marginTop: 26,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 10,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.line,
  },
  dividerText: {
    fontSize: 11,
    color: Colors.soft,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  autofillGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  autofillCard: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    gap: 3,
    borderWidth: 1.5,
  },
  autofillCardActive: {
    borderColor: Colors.forest,
    backgroundColor: Colors.forest50,
  },
  autofillCardInactive: {
    borderColor: Colors.line,
    backgroundColor: Colors.card,
  },
  autofillLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  autofillLabelActive: {
    color: Colors.forest,
  },
  autofillLabelInactive: {
    color: Colors.ink,
  },
  autofillIdText: {
    fontSize: 10,
    color: Colors.soft,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  labLink: {
    marginTop: 20,
    alignItems: 'center',
  },
  labLinkText: {
    fontSize: 13,
    color: Colors.soft,
    textDecorationLine: 'underline',
  },
});
