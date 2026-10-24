/**
 * Realistic Classroom Synthetic Test Dataset Specification & Generator
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements Phase 8 Realistic Test Data requirements:
 * - Controlled test scenarios representing realistic classroom conditions
 * - Strict documentation: All datasets labeled SYNTHETIC_DEMO_DATA / DEV_TEST_DATA
 * - Zero real student biometrics committed to repository
 * - Scenarios:
 *   1. Frontal / near-frontal (baseline)
 *   2. Left / right yaw variation (+/- 20 deg)
 *   3. Up / down pitch variation (+/- 15 deg)
 *   4. Variable distance / scale (close up 100px, mid-row 60px, back-row 35px)
 *   5. Classroom lighting (bright front, dim ambient, side window glare)
 *   6. Multi-face crowded scenes (1, 5, 10, 20, 30 students)
 *   7. Partial occlusion (glasses, hand near chin, notebook)
 *   8. Camera movement / panning sweep
 *   9. Students entering and leaving the field of view
 */

import type { FaceBoundingBox, FaceDetectionResult, RawFrame } from '../../perception/contracts.ts';

export type DatasetClassification = 'SYNTHETIC_DEMO_DATA' | 'DEV_TEST_DATA' | 'REAL_STUDENT_DATA';

export interface ClassroomScenarioMetadata {
  id: string;
  name: string;
  classification: DatasetClassification;
  description: string;
  simulatedFacesCount: number;
  lightingCondition: 'NORMAL' | 'DIM' | 'SIDE_GLARE' | 'BACKLIT';
  distanceCategory: 'FRONT_ROW' | 'MID_ROW' | 'REAR_ROW' | 'MIXED';
  poseCategory: 'FRONTAL' | 'YAW_VARYING' | 'PITCH_VARYING' | 'EXTREME';
  occlusionType: 'NONE' | 'GLASSES' | 'PARTIAL_FACE';
  expectedDetections: number;
  expectedRecognitionSuccessRatio: number;
}

export const CLASSROOM_TEST_SCENARIOS: ClassroomScenarioMetadata[] = [
  {
    id: 'SCENARIO_01_FRONTAL_BASELINE',
    name: 'Frontal Baseline — 5 Students',
    classification: 'SYNTHETIC_DEMO_DATA',
    description: 'Clean frontal portraits at 2.5m distance under standard 400 lux classroom lighting.',
    simulatedFacesCount: 5,
    lightingCondition: 'NORMAL',
    distanceCategory: 'FRONT_ROW',
    poseCategory: 'FRONTAL',
    occlusionType: 'NONE',
    expectedDetections: 5,
    expectedRecognitionSuccessRatio: 1.0,
  },
  {
    id: 'SCENARIO_02_YAW_ROTATION',
    name: 'Pose Variation — Left/Right Yaw',
    classification: 'SYNTHETIC_DEMO_DATA',
    description: 'Students looking at blackboard or taking notes (yaw between -25° and +25°).',
    simulatedFacesCount: 6,
    lightingCondition: 'NORMAL',
    distanceCategory: 'MID_ROW',
    poseCategory: 'YAW_VARYING',
    occlusionType: 'NONE',
    expectedDetections: 6,
    expectedRecognitionSuccessRatio: 0.85,
  },
  {
    id: 'SCENARIO_03_DISTANT_REAR_ROW',
    name: 'Distant Back Row — Small Faces (<45px)',
    classification: 'SYNTHETIC_DEMO_DATA',
    description: 'Students seated 6–8 meters away from mobile camera; face size 35px to 50px.',
    simulatedFacesCount: 8,
    lightingCondition: 'DIM',
    distanceCategory: 'REAR_ROW',
    poseCategory: 'FRONTAL',
    occlusionType: 'NONE',
    expectedDetections: 6, // Quality gate expected to filter smallest faces until camera moves closer
    expectedRecognitionSuccessRatio: 0.70,
  },
  {
    id: 'SCENARIO_04_WINDOW_GLARE',
    name: 'Adverse Lighting — Side Glare / Backlight',
    classification: 'SYNTHETIC_DEMO_DATA',
    description: 'Classroom with natural side window causing asymmetric brightness and shadows.',
    simulatedFacesCount: 5,
    lightingCondition: 'SIDE_GLARE',
    distanceCategory: 'MID_ROW',
    poseCategory: 'FRONTAL',
    occlusionType: 'NONE',
    expectedDetections: 5,
    expectedRecognitionSuccessRatio: 0.80,
  },
  {
    id: 'SCENARIO_05_CROWDED_DENSE',
    name: 'Crowded Dense Lecture Hall (25 Faces)',
    classification: 'SYNTHETIC_DEMO_DATA',
    description: 'Dense amphitheater style seating with 25 visible students across all three depth tiers.',
    simulatedFacesCount: 25,
    lightingCondition: 'NORMAL',
    distanceCategory: 'MIXED',
    poseCategory: 'FRONTAL',
    occlusionType: 'NONE',
    expectedDetections: 22,
    expectedRecognitionSuccessRatio: 0.88,
  },
  {
    id: 'SCENARIO_06_PARTIAL_OCCLUSION',
    name: 'Partial Occlusions — Glasses & Hands',
    classification: 'SYNTHETIC_DEMO_DATA',
    description: 'Students wearing thick-rimmed glasses or resting hands on chin while listening.',
    simulatedFacesCount: 4,
    lightingCondition: 'NORMAL',
    distanceCategory: 'FRONT_ROW',
    poseCategory: 'FRONTAL',
    occlusionType: 'GLASSES',
    expectedDetections: 4,
    expectedRecognitionSuccessRatio: 0.90,
  },
  {
    id: 'SCENARIO_07_CAMERA_PAN_SWEEP',
    name: 'Camera Motion — Panning Across Room',
    classification: 'SYNTHETIC_DEMO_DATA',
    description: 'Faculty sweeps phone horizontally across room at ~15 deg/sec; tracking must maintain IDs.',
    simulatedFacesCount: 15,
    lightingCondition: 'NORMAL',
    distanceCategory: 'MIXED',
    poseCategory: 'YAW_VARYING',
    occlusionType: 'NONE',
    expectedDetections: 13,
    expectedRecognitionSuccessRatio: 0.82,
  },
];
