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
} from 'lucide-react-native';

import { Colors, Radii } from '@/theme/tokens';
import { Button } from '@/components/ui/kit';

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
    defaultId: '21CS037',
    field: 'Roll number',
  },
  {
    key: 'faculty',
    label: 'Faculty',
    icon: Presentation,
    defaultId: 'FAC-0142',
    field: 'Staff ID',
  },
  {
    key: 'admin',
    label: 'Admin',
    icon: ShieldCheck,
    defaultId: 'ADM-0007',
    field: 'Admin ID',
  },
];

export default function LoginScreen() {
  const router = useRouter();
  const [selectedRole, setSelectedRole] = useState<RoleKey>('faculty');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const currentRole = ROLES.find((r) => r.key === selectedRole)!;
  const [identifier, setIdentifier] = useState(currentRole.defaultId);
  const [password, setPassword] = useState('college2026');

  const handleRoleSelect = (roleKey: RoleKey) => {
    setSelectedRole(roleKey);
    const roleConfig = ROLES.find((r) => r.key === roleKey)!;
    setIdentifier(roleConfig.defaultId);
  };

  const handleSignIn = () => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      if (selectedRole === 'student') {
        router.replace('/(student)/attendance');
      } else {
        router.replace('/(faculty)');
      }
    }, 600);
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
              {/* App Mark Box */}
              <View style={styles.logoBox}>
                <Text style={styles.logoText}>a</Text>
              </View>

              {/* Title Header */}
              <Text style={styles.heroTitle}>
                Welcome to{'\n'}
                <Text style={styles.heroTitleBrand}>Attendly</Text>
              </Text>

              {/* Subtitle */}
              <Text style={styles.heroSubtitle}>
                Attendance, without the roll call.
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
  logoBox: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  logoText: {
    fontSize: 26,
    fontWeight: '700',
    color: '#ffffff',
    marginTop: -2,
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
});
