import React, { ReactNode, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Modal,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import { ChevronLeft } from 'lucide-react-native';
import { Colors, Radii, Shadows, Tone, ToneColors } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';

// ---------------------------------------------------------------------------
// Screen Container
// ---------------------------------------------------------------------------
interface ScreenProps {
  children: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  onBack?: () => void;
  left?: ReactNode;
  right?: ReactNode;
  hero?: ReactNode;
  scrollable?: boolean;
}

export function Screen({
  children,
  title,
  subtitle,
  onBack,
  left,
  right,
  hero,
  scrollable = true,
}: ScreenProps) {
  const content = (
    <View style={styles.screenInner}>
      {(onBack || right || left) && (
        <View style={styles.navRow}>
          {onBack ? (
            <Pressable
              onPress={onBack}
              hitSlop={12}
              style={styles.backButton}
              accessibilityLabel="Back"
            >
              <ChevronLeft size={24} color={Colors.ink} />
            </Pressable>
          ) : left ? (
            <View style={{ justifyContent: 'center' }}>{left}</View>
          ) : (
            <View style={{ width: 40 }} />
          )}
          <View style={styles.navRight}>{right}</View>
        </View>
      )}

      {(subtitle || title) && (
        <View style={styles.headerBlock}>
          {subtitle && typeof subtitle === 'string' ? (
            <Text style={styles.headerSubtitle}>{subtitle}</Text>
          ) : (
            subtitle
          )}
          {title && typeof title === 'string' ? (
            <Text style={styles.headerTitle}>{title}</Text>
          ) : (
            title
          )}
        </View>
      )}

      {hero}
      <View style={styles.body}>{children}</View>
    </View>
  );

  return (
    <SafeAreaView style={styles.screenContainer} edges={['top', 'left', 'right', 'bottom']}>
      {scrollable ? (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
interface CardProps {
  children: ReactNode;
  onPress?: () => void;
  style?: object;
  tone?: 'normal' | 'apricot' | 'forest' | 'amber';
}

export function Card({ children, onPress, style, tone = 'normal' }: CardProps) {
  const bgStyle =
    tone === 'apricot'
      ? { backgroundColor: Colors.apricot50 }
      : tone === 'forest'
      ? { backgroundColor: Colors.forest50 }
      : tone === 'amber'
      ? { backgroundColor: Colors.amber50 }
      : { backgroundColor: Colors.card };

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.card,
          bgStyle,
          Shadows.card,
          pressed && styles.cardPressed,
          style,
        ]}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View style={[styles.card, bgStyle, Shadows.card, style]}>{children}</View>
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------
interface ButtonProps {
  children: ReactNode;
  onPress?: () => void;
  variant?: 'primary' | 'soft' | 'ghost';
  tone?: Tone;
  disabled?: boolean;
  style?: object;
  icon?: ReactNode;
}

export function Button({
  children,
  onPress,
  variant = 'primary',
  tone,
  disabled = false,
  style,
  icon,
}: ButtonProps) {
  const isPrimary = variant === 'primary';
  const isSoft = variant === 'soft';

  const toneBg = tone && ToneColors[tone]?.bg;
  const toneText = tone && ToneColors[tone]?.text;

  const containerStyle = toneBg
    ? { backgroundColor: tone === 'forest' ? Colors.forest : tone === 'rose' ? Colors.rose : toneBg }
    : isPrimary
    ? styles.buttonPrimary
    : isSoft
    ? styles.buttonSoft
    : styles.buttonGhost;

  const textStyle = toneText
    ? { color: (tone === 'forest' || tone === 'rose') ? '#FFFFFF' : toneText }
    : isPrimary
    ? styles.buttonPrimaryText
    : isSoft
    ? styles.buttonSoftText
    : styles.buttonGhostText;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.buttonBase,
        containerStyle,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
        style,
      ]}
    >
      {icon && <View style={styles.buttonIcon}>{icon}</View>}
      {React.isValidElement(children) ? (
        children
      ) : (
        <Text style={[styles.buttonTextBase, textStyle]}>{children}</Text>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Section Title
// ---------------------------------------------------------------------------
interface SectionTitleProps {
  children?: ReactNode;
  title?: ReactNode;
  badge?: ReactNode;
  action?: ReactNode;
}

export function SectionTitle({ children, title, badge, action }: SectionTitleProps) {
  const content = children ?? title;
  return (
    <View style={styles.sectionTitleRow}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
        {React.isValidElement(content) ? (
          content
        ) : (
          <Text style={styles.sectionTitleText}>{content}</Text>
        )}
        {badge && (
          <View style={{ marginLeft: 8 }}>
            {typeof badge === 'string' ? <Chip tone="soft">{badge}</Chip> : badge}
          </View>
        )}
      </View>
      {action}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------
interface ChipProps {
  children: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  style?: object;
}

export function Chip({ children, tone = 'soft', icon, style }: ChipProps) {
  const { bg, text } = ToneColors[tone] || ToneColors.soft;
  return (
    <View style={[styles.chip, { backgroundColor: bg }, style]}>
      {icon && <View style={styles.chipIcon}>{icon}</View>}
      {React.isValidElement(children) ? (
        children
      ) : (
        <Text style={[styles.chipText, { color: text }]}>{children}</Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// IconBubble
// ---------------------------------------------------------------------------
interface IconBubbleProps {
  icon: any; // Lucide icon component
  tone?: Tone;
  size?: number;
  iconSize?: number;
}

export function IconBubble({
  icon: IconComponent,
  tone = 'forest',
  size = 44,
  iconSize,
}: IconBubbleProps) {
  const { bg, text } = ToneColors[tone] || ToneColors.forest;
  const renderedIconSize = iconSize ?? size * 0.46;
  return (
    <View
      style={[
        styles.iconBubble,
        {
          width: size,
          height: size,
          borderRadius: Radii.bubble,
          backgroundColor: bg,
        },
      ]}
    >
      <IconComponent size={renderedIconSize} color={text} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Circular Attendance Ring
// ---------------------------------------------------------------------------
interface RingProps {
  pct: number;
  size?: number;
  stroke?: number;
  threshold?: number;
}

export function Ring({
  pct,
  size = 90,
  stroke = 8,
  threshold = 75,
}: RingProps) {
  const clampedPct = Math.min(100, Math.max(0, Math.round(pct)));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - clampedPct / 100);
  const strokeColor = clampedPct < threshold ? Colors.rose : Colors.forest;

  return (
    <View style={[styles.ringContainer, { width: size, height: size }]}>
      <Svg width={size} height={size} style={styles.ringSvg}>
        {/* Track */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="#f1ebe0"
          strokeWidth={stroke}
          fill="none"
        />
        {/* Progress */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={strokeColor}
          strokeWidth={stroke}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          fill="none"
          originX={size / 2}
          originY={size / 2}
          rotation="-90"
        />
      </Svg>
      <View style={styles.ringTextContainer}>
        <Text style={[styles.ringText, { fontSize: size / 3.4 }]}>
          {clampedPct}
          <Text style={styles.ringPercentSign}>%</Text>
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Bar Progress
// ---------------------------------------------------------------------------
interface BarProps {
  pct: number;
  threshold?: number;
}

export function Bar({ pct, threshold = 75 }: BarProps) {
  const clamped = Math.min(100, Math.max(0, pct));
  const isBelow = clamped < threshold;
  return (
    <View style={styles.barTrack}>
      <View
        style={[
          styles.barFill,
          {
            width: `${clamped}%`,
            backgroundColor: isBelow ? Colors.rose : Colors.forest,
          },
        ]}
      />
      {threshold && (
        <View style={[styles.barThresholdNotch, { left: `${threshold}%` }]} />
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------
const AVATAR_PALETTES = [
  { bg: Colors.apricot50, text: '#b86a2a' },
  { bg: Colors.forest50, text: Colors.forest },
  { bg: Colors.lilac50, text: Colors.lilac },
  { bg: Colors.rose50, text: Colors.rose },
  { bg: Colors.amber50, text: Colors.amber },
];

export function Avatar({
  name,
  size = 40,
  userId,
  photoUrl,
}: {
  name: string;
  size?: number;
  userId?: string | null;
  photoUrl?: string | null;
}) {
  const [hasError, setHasError] = useState(false);
  const effectiveUrl = photoUrl || (userId ? `${API_BASE_URL}/api/v1/users/${userId}/profile-photo` : null);

  React.useEffect(() => {
    setHasError(false);
  }, [userId, photoUrl]);

  if (effectiveUrl && !hasError) {
    return (
      <Image
        source={{ uri: effectiveUrl }}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: Colors.line,
        }}
        onError={() => setHasError(true)}
      />
    );
  }

  const hash = Array.from(name || 'A').reduce(
    (acc, char) => acc + char.charCodeAt(0),
    0
  );
  const palette = AVATAR_PALETTES[hash % AVATAR_PALETTES.length];
  const initials = (name || 'A')
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: palette.bg,
        },
      ]}
    >
      <Text
        style={[
          styles.avatarText,
          { color: palette.text, fontSize: size / 2.7 },
        ]}
      >
        {initials}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Bottom Sheet / Dialog
// ---------------------------------------------------------------------------
interface SheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function Sheet({ visible, onClose, children }: SheetProps) {
  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable
          style={styles.sheetContent}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.sheetHandle} />
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 110,
  },
  screenInner: {
    flex: 1,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    height: 48,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  navRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerBlock: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 12,
  },
  headerSubtitle: {
    fontSize: 14,
    color: Colors.soft,
    marginBottom: 2,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: Colors.ink,
    letterSpacing: -0.4,
  },
  body: {
    paddingHorizontal: 20,
  },
  card: {
    borderRadius: Radii.card,
    padding: 16,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: '#efe7da88',
  },
  cardPressed: {
    transform: [{ scale: 0.985 }],
    opacity: 0.95,
  },
  buttonBase: {
    width: '100%',
    height: 52,
    borderRadius: Radii.button,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonPrimary: {
    backgroundColor: Colors.forest,
  },
  buttonSoft: {
    backgroundColor: Colors.forest50,
  },
  buttonGhost: {
    backgroundColor: 'transparent',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonPressed: {
    transform: [{ scale: 0.98 }],
  },
  buttonIcon: {
    marginRight: 4,
  },
  buttonTextBase: {
    fontSize: 15,
    fontWeight: '600',
  },
  buttonPrimaryText: {
    color: '#ffffff',
  },
  buttonSoftText: {
    color: Colors.forest,
  },
  buttonGhostText: {
    color: Colors.soft,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 12,
  },
  sectionTitleText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.ink,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 4.5,
    alignSelf: 'flex-start',
    gap: 4,
  },
  chipIcon: {
    marginRight: 2,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '700',
  },
  iconBubble: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  ringContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  ringSvg: {
    position: 'absolute',
  },
  ringTextContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  ringText: {
    fontWeight: '700',
    color: Colors.ink,
  },
  ringPercentSign: {
    fontSize: 11,
    color: Colors.soft,
    fontWeight: '600',
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.line,
    width: '100%',
    overflow: 'hidden',
    position: 'relative',
  },
  barFill: {
    height: '100%',
    borderRadius: 4,
  },
  barThresholdNotch: {
    position: 'absolute',
    top: 0,
    width: 2,
    height: 8,
    backgroundColor: 'rgba(42,35,56,0.3)',
  },
  avatar: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontWeight: '700',
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(42,35,56,0.4)',
    justifyContent: 'flex-end',
  },
  sheetContent: {
    backgroundColor: Colors.card,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 44 : 28,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.line,
    alignSelf: 'center',
    marginBottom: 18,
  },
});
