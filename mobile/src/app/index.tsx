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
  field: string;
}

const ROLES: RoleOption[] = [
  {
    key: 'student',
    label: 'Student',
    icon: GraduationCap,
    defaultId: 'S3',
    field: 'Roll number',
  },
  {
    key: 'faculty',
    label: 'Faculty',
    icon: Presentation,
    defaultId: 'prof_alan',
    field: 'Staff ID',
  },
  {
    key: 'admin',
    label: 'Admin',
    icon: ShieldCheck,
    defaultId: 'admin_meera',
    field: 'Admin ID',
  },
];

export default function LoginScreen() {
  const router = useRouter();
  const [selectedRole, setSelectedRole] = useState<RoleKey>('faculty');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const currentRole = ROLES.find((r) => r.key === selectedRole)!;
  const [identifier, setIdentifier] = useState(currentRole.defaultId);
  const [password, setPassword] = useState('password');

  const handleRoleSelect = (roleKey: RoleKey) => {
    setSelectedRole(roleKey);
    setAuthError(null);
    const roleConfig = ROLES.find((r) => r.key === roleKey)!;
    setIdentifier(roleConfig.defaultId);
    setPassword('password');
  };

  const handleSignIn = async () => {
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
      if (cached?.user && cached.user.role.toLowerCase() === selectedRole.toLowerCase()) {
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
            <Text style={styles.sectionPrompt}>I am a…</Text>

            {/* 3-Column Role Picker */}
            <View style={styles.rolesGrid}>
              {ROLES.map((role) => {
                const IconComponent = role.icon;
                const isSelected = selectedRole === role.key;

                return (
                  <Pressable
                    key={role.key}
                    onPress={() => handleRoleSelect(role.key)}
                    style={[
                      styles.roleCard,
                      isSelected ? styles.roleCardActive : styles.roleCardInactive,
                    ]}
                  >
                    <IconComponent
                      size={22}
                      color={isSelected ? Colors.forest : Colors.soft}
                    />
                    <Text
                      style={[
                        styles.roleLabel,
                        isSelected ? styles.roleLabelActive : styles.roleLabelInactive,
                      ]}
                    >
                      {role.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* Error Banner */}
            {authError && (
              <View style={styles.errorBanner}>
                <AlertCircle size={18} color="#dc2626" />
                <Text style={styles.errorBannerText}>{authError}</Text>
              </View>
            )}

            {/* Identifier Input */}
            <View style={styles.fieldContainer}>
              <Text style={styles.fieldLabel}>{currentRole.field}</Text>
              <TextInput
                style={styles.input}
                value={identifier}
                onChangeText={setIdentifier}
                placeholder={`Enter ${currentRole.field.toLowerCase()}`}
                placeholderTextColor={Colors.soft}
                autoCapitalize="characters"
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

              {/* Developer Lab Shortcut */}
              <Pressable
                onPress={() => router.push('/lab/perception')}
                style={{ marginTop: 16, alignItems: 'center' }}
              >
                <Text style={{ fontSize: 13, color: Colors.soft, textDecorationLine: 'underline' }}>
                  🔬 Open Perception Diagnostic Lab
                </Text>
              </Pressable>
            </View>
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
    minHeight: 280,
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
    fontSize: 38,
    lineHeight: 42,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.5,
  },
  heroTitleBrand: {
    color: Colors.apricot,
    fontStyle: 'italic',
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
  sectionPrompt: {
    fontSize: 14,
    color: Colors.soft,
    marginBottom: 12,
  },
  rolesGrid: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
  },
  roleCard: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    gap: 6,
    borderWidth: 2,
  },
  roleCardActive: {
    borderColor: Colors.forest,
    backgroundColor: Colors.forest50,
  },
  roleCardInactive: {
    borderColor: Colors.line,
    backgroundColor: Colors.card,
  },
  roleLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  roleLabelActive: {
    color: Colors.forest,
  },
  roleLabelInactive: {
    color: Colors.soft,
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
    marginTop: 'auto',
    paddingTop: 24,
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
});
