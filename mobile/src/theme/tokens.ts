/**
 * Klasio Design Tokens
 * Source of truth: Klasio Brand Identity Showcase & guidelines
 */

export const Colors = {
  cream: '#F8F2E7', // Klasio App Background
  card: '#ffffff',  // card surfaces
  ink: '#302630',   // Klasio Primary Text
  soft: '#706677',  // secondary text
  line: '#EBE4D8',  // subtle borders & dividers

  // Primary Brand
  forest: '#205442',   // Klasio Primary Brand / Buttons
  primary: '#205442',  // Primary Brand Alias
  forest50: '#E7EFEA', // Klasio soft mint surface

  // Secondary Brand
  secondary: '#7F8D64',   // Klasio Secondary Accents / Highlights
  secondary50: '#F0F3EC', // Klasio secondary tint

  // Highlight
  apricot: '#f0a868',
  apricot50: '#fdeedf',

  // Warning / Danger / Absent
  rose: '#d65f57',
  rose50: '#fbe6e3',

  // Alert / Waiting / Late / Pending
  amber: '#d99a2b',
  amber50: '#fbf0d9',

  // Biometrics / Face ID
  lilac: '#7a6bb8',
  lilac50: '#eeebf8',
  // Aliases & shades
  inkSecondary: '#706677',
  inkTertiary: '#9e94a5',
} as const;

export const Radii = {
  sm: 8,
  md: 14,
  lg: 24,
  card: 24,
  button: 16,
  bubble: 14,
  pill: 9999,
} as const;

export const Shadows = {
  card: {
    shadowColor: '#302630',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 3,
  },
  soft: {
    shadowColor: '#302630',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 1,
  },
} as const;

export type Tone = 'forest' | 'secondary' | 'rose' | 'amber' | 'lilac' | 'apricot' | 'soft';

export const ToneColors: Record<Tone, { bg: string; text: string }> = {
  forest: { bg: Colors.forest50, text: Colors.forest },
  secondary: { bg: Colors.secondary50, text: Colors.secondary },
  rose: { bg: Colors.rose50, text: Colors.rose },
  amber: { bg: Colors.amber50, text: Colors.amber },
  lilac: { bg: Colors.lilac50, text: Colors.lilac },
  apricot: { bg: Colors.apricot50, text: '#b86a2a' },
  soft: { bg: Colors.line, text: Colors.soft },
};
