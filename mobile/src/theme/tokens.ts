/**
 * Attendly Design Tokens
 * Source of truth: designs/guidelines/Guidelines.md & designs/src/index.css
 */

export const Colors = {
  cream: '#fbf6ee', // background ground
  card: '#ffffff',  // card surfaces
  ink: '#2a2338',   // primary text & plum ink
  soft: '#756d82',  // secondary text
  line: '#efe7da',  // subtle borders & dividers

  // Primary
  forest: '#2e6b57',
  forest50: '#e4f1ea',

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
} as const;

export const Radii = {
  card: 24,
  button: 16,
  bubble: 14,
  pill: 9999,
} as const;

export const Shadows = {
  card: {
    shadowColor: '#2a2338',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 3,
  },
  soft: {
    shadowColor: '#2a2338',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 1,
  },
} as const;

export type Tone = 'forest' | 'rose' | 'amber' | 'lilac' | 'apricot' | 'soft';

export const ToneColors: Record<Tone, { bg: string; text: string }> = {
  forest: { bg: Colors.forest50, text: Colors.forest },
  rose: { bg: Colors.rose50, text: Colors.rose },
  amber: { bg: Colors.amber50, text: Colors.amber },
  lilac: { bg: Colors.lilac50, text: Colors.lilac },
  apricot: { bg: Colors.apricot50, text: '#b86a2a' },
  soft: { bg: Colors.line, text: Colors.soft },
};
