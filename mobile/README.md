# Klasio Mobile

> **Every class, in sync.**  
> Smart attendance for every class.

Klasio helps colleges take attendance, keep records in sync, and turn classroom data into useful insights.

Academic Project Title:  
`Automated Student Attendance Monitoring and Analytics System for Colleges`

Target Device: **Motorola Moto G54 5G** (Android 15 / API 35, MediaTek Dimensity 7020, `arm64-v8a`)

---

## 1. Brand Identity & Design System

- **Product Name**: Klasio
- **Tagline**: Every class, in sync.
- **Product Descriptor**: Smart attendance for every class.
- **Brand Palette**:
  - Primary: `#205442` (Deep Forest Green)
  - Secondary: `#7F8D64` (Sage / Olive Accent)
  - Background: `#F8F2E7` (Warm Cream / Ivory)
  - Card / Surface: `#FFFFFF` (Pure White)
  - Primary Text: `#302630` (Espresso Plum)
  - Muted Text: `#6B7280` (Neutral Grey)
  - Accent / Attention: `#F59E0B` (Amber Warning), `#EF4444` (Crimson Shortage)

---

## 2. On-Device Native Perception Engine

Implemented via native Kotlin JNI module (`com.klasio.app.perception.DirectPerceptionModule`) and ONNX Runtime:

1. **In-Memory Frame Grab**: Zero-copy bitmap extraction from CameraX `PreviewView.getBitmap()` in memory, eliminating JPEG compression and flash I/O bottlenecks.
2. **YuNet Face Detector (`models/face_detection_yunet_2023mar.onnx`)**: Multi-scale edge face detector evaluating frames at 640x640 with confidence threshold 0.35, extracting bounding boxes and 5 canonical facial landmarks.
3. **ArcFace 5-Point Canonical Alignment**: Hardware-accelerated Skia `Matrix` affine transformation mapping 5 keypoints to standard ArcFace coordinates (112x112 ARGB_8888).
4. **EdgeFace-XS Embedder (`models/edgeface_xs.onnx`)**: Hybrid CNN-Vision Transformer edge neural model (6.94 MB ONNX) extracting unit L2-normalized 512-D vectors in R^512 via NCHW RGB float normalization: `(val - 127.5f) / 127.5f` (symmetric $[-1.0, 1.0]$ bounds).
5. **Session-Scoped Roster Matcher**: Dynamic gallery matching restricted strictly to students enrolled in the active teaching assignment, with Top-2 margin separation ($\Delta \ge 0.10$) and temporal observation-rate confirmation.

---

## 3. Role Shells

1. **Faculty Shell (`/(faculty)`)**:
   - **Home**: Today's scheduled classes and quick attendance launcher.
   - **Classes**: Assigned course sections and roster intelligence.
   - **Reports**: Real attendance analytics, shortage trends, and CSV export.
   - **Profile**: Device authorization, sync queue, and biometric model telemetry.
   - **Center Action**: Elevated `Scan Face` workflow with full-screen isolation and real-time bounding box / landmark overlay.

2. **Student Shell (`/(student)`)**:
   - **Home**: Overall attendance percentage ring and recovery guidance.
   - **Attendance**: Monthly attendance calendar and subject-by-subject breakdown.
   - **Requests**: Attendance dispute/grievance timeline tracker and report sheet.
   - **Profile**: Biometric Face ID setup status and privacy standards.
   - **Guided Enrollment**: 3-pose registration (`FRONTAL`, `SLIGHT_LEFT`, `SLIGHT_RIGHT`) with pairwise consistency validation ($\ge 0.60$).

3. **Admin Shell (`/(admin)`)**:
   - **Home**: Institutional metrics (attendance rate, active classes, operational alerts).
   - **People**: Student and faculty directory with teaching assignments.
   - **Academics**: Department overview and terms.
   - **Settings**: Biometric baseline configuration, data retention, and device broadcast.

---

## 4. Development & Build Instructions

### Prerequisites
- Node.js 20+ / npm 10+
- JDK 17 (configured via `org.gradle.java.home` in `android/gradle.properties`)
- Android SDK 35 with NDK 27+

### Verification & Testing
```bash
# Execute full unit & invariant test suite (16 suites, 82 assertions)
npm test

# TypeScript type check (0 errors)
npx tsc --noEmit
```

### Assemble Debug APK & Deploy to Device
```bash
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Assemble Standalone Release APK
```bash
cd android
./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

### Start Development Server
```bash
# Reverse ports for connected device over USB
adb reverse tcp:8000 tcp:8000
adb reverse tcp:8081 tcp:8081

# Start Metro bundler
npx expo start --localhost
```
