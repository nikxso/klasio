import React, { useState, useEffect } from 'react';
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
  Eye,
  EyeOff,
  AlertCircle,
  ShieldCheck,
} from 'lucide-react-native';

import { Colors, Radii } from '@/theme/tokens';
import { Button } from '@/components/ui/kit';
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import { Brand } from '@/constants/brand';
import { API_BASE_URL } from '@/config/api';
import { RoleAssignmentInfo, SessionStore } from '@/storage/sessionStore';

export function resolveTargetRoute(user?: { permissions?: string[]; role?: string } | null): string {
  const role = user?.role ? user.role.toUpperCase() : '';

  // 1. Explicit Student role or student self-enrollment always routes to student workspace
  if (role === 'STUDENT' || (user?.permissions?.some(p => p === 'biometrics.enroll.self') && !user?.permissions?.some(p => p === 'attendance.session.start'))) {
    return '/(student)';
  }

  // 2. Direct attendance conduct capabilities (Faculty, TAs)
  if (user?.permissions?.some(p => p === 'attendance.session.start' || p === 'attendance.session.create') || role === 'FACULTY') {
    return '/(faculty)';
  }

  // 3. Central & Campus Administration
  if (user?.permissions?.some(p => p.startsWith('institution.') || p.startsWith('campus.') || p.startsWith('academic_structure.')) || role === 'ADMIN') {
    return '/(admin)';
  }

  // 4. Fallback based on legacy role
  if (role === 'ADMIN') return '/(admin)';
  if (role === 'STUDENT') return '/(student)';
  return '/(faculty)';
}

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [checkingSession, setCheckingSession] = useState(true);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function checkExistingSession() {
      try {
        const session = SessionStore.getSession() || (await SessionStore.initFromStorage());
        if (session?.user && session?.token && isMounted) {
          const targetRoute = resolveTargetRoute(session.user);
          router.replace(targetRoute as any);
          return;
        }
      } catch (err) {
        console.warn('[AUTH] Error checking existing session on launch:', err);
      } finally {
        if (isMounted) {
          setCheckingSession(false);
        }
      }
    }
    checkExistingSession();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const unsub = SessionStore.subscribe((session) => {
      if (!session) {
        setCheckingSession(false);
        setIdentifier('');
        setPassword('');
        setAuthError(null);
        setLoading(false);
      }
    });
    return unsub;
  }, []);

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
        const roleAssignments: RoleAssignmentInfo[] | undefined = Array.isArray(data.user?.role_assignments)
          ? data.user.role_assignments.map((ra: any) => ({
              roleTemplateCode: ra.role_template_code ?? ra.roleTemplateCode,
              roleTemplateName: ra.role_template_name ?? ra.roleTemplateName,
              scopeType: ra.scope_type ?? ra.scopeType,
              departmentCode: ra.department_code ?? ra.departmentCode,
              validFrom: ra.valid_from ? String(ra.valid_from) : ra.validFrom,
              validUntil: ra.valid_until ? String(ra.valid_until) : ra.validUntil,
            }))
          : undefined;

        const authUser = {
          id: data.user.id,
          institutionalId: data.user.institutional_id,
          email: data.user.email,
          fullName: data.user.full_name,
          role: data.user.role,
          faceRegistrationState: data.user.face_registration_state,
          institutionId: data.user.institution_id,
          membershipId: data.user.membership_id,
          authorizationVersion: data.user.authorization_version,
          authorizationSnapshot: data.user.authorization_snapshot,
          permissions: Array.isArray(data.user.permissions) ? data.user.permissions : undefined,
          roleAssignments,
        };

        await SessionStore.setSession({
          token: data.access_token,
          user: authUser,
        });
        setLoading(false);
        const targetRoute = resolveTargetRoute(authUser);
        router.replace(targetRoute as any);
        return;
      } else {
        let errMsg = res.status >= 500
          ? `Server error (${res.status}). The service is currently restarting or unavailable. Please try again shortly.`
          : 'Invalid credentials. Please verify your ID and password.';
        try {
          const errJson = await res.json();
          if (errJson?.message) errMsg = errJson.message;
          else if (errJson?.detail) errMsg = errJson.detail;
        } catch (_) {}
        setAuthError(errMsg);
        setLoading(false);
        return;
      }
    } catch (e) {
      console.warn('[AUTH] Offline/connection error during login:', e);
      const cached = await SessionStore.initFromStorage();
      if (cached?.user) {
        // Enforce strict identity matching: never restore a cached session belonging to a different user!
        const requestedId = identifier.trim().toLowerCase();
        const cachedInstId = (cached.user.institutionalId || '').toLowerCase();
        const cachedEmail = (cached.user.email || '').toLowerCase();
        const cachedId = (cached.user.id || '').toLowerCase();

        if (requestedId === cachedInstId || requestedId === cachedEmail || requestedId === cachedId) {
          setLoading(false);
          const targetRoute = resolveTargetRoute(cached.user);
          router.replace(targetRoute as any);
          return;
        }
      }
      setAuthError('Unable to connect to attendance server. Please check your network connection.');
      setLoading(false);
      return;
    }
  };

  if (checkingSession) {
    return (
      <View style={[styles.container, styles.loadingContainer]}>
        <StatusBar style="light" />
        <View style={styles.loadingCard}>
          <KlasioLogo variant="mark" size={56} />
          <ActivityIndicator size="small" color={Colors.forest} style={{ marginTop: 20 }} />
          <Text style={styles.loadingText}>Restoring session...</Text>
        </View>
      </View>
    );
  }

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
            <Text style={styles.formSubtitle}>Enter your institutional credentials to access attendance</Text>

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
                placeholder="Enter Institutional ID (e.g. S10294 or faculty ID)"
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

            {/* Institutional Security Notice */}
            <View style={styles.securityNotice}>
              <ShieldCheck size={16} color={Colors.soft} />
              <Text style={styles.securityNoticeText}>
                Secured by Klasio Biometric Architecture • Privacy Compliant
              </Text>
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
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.cream,
  },
  loadingCard: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  loadingText: {
    fontSize: 14,
    color: Colors.soft,
    marginTop: 12,
    fontWeight: '500',
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
    paddingTop: 28,
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
    marginBottom: 24,
    lineHeight: 20,
  },
  fieldContainer: {
    marginBottom: 18,
  },
  fieldLabel: {
    fontSize: 13,
    color: Colors.ink,
    marginBottom: 8,
    fontWeight: '600',
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
    marginTop: 12,
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
    marginBottom: 18,
    gap: 8,
  },
  errorBannerText: {
    flex: 1,
    fontSize: 13,
    color: '#b91c1c',
    lineHeight: 18,
  },
  securityNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 36,
    paddingHorizontal: 12,
  },
  securityNoticeText: {
    fontSize: 12,
    color: Colors.soft,
    textAlign: 'center',
  },
});
