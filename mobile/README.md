# Klasio Mobile

> **Every class, in sync.**
> Smart attendance for every class.

Klasio helps colleges take attendance, keep records in sync, and turn classroom data into useful insights.

Academic Project Title:
`Automated Student Attendance Monitoring and Analytics System for Colleges`

---

## Brand Identity

- **Product Name**: Klasio
- **Tagline**: Every class, in sync.
- **Product Descriptor**: Smart attendance for every class.
- **Brand Palette**:
  - Primary: `#205442` (Deep Forest Green)
  - Secondary: `#7F8D64` (Sage / Olive Accent)
  - Background: `#F8F2E7` (Warm Cream / Ivory)
  - Primary Text: `#302630` (Espresso Plum)

---

## Role Shells

1. **Faculty Shell (`/(faculty)`)**:
   - Home: Today's scheduled classes and quick attendance launcher.
   - Classes: Assigned course sections and roster intelligence.
   - Reports: Real attendance analytics, shortage trends, and CSV export.
   - Profile: Device authorization, sync queue, and biometric model telemetry.
   - Center Action: Elevated `Scan Face` workflow with full-screen isolation.

2. **Student Shell (`/(student)`)**:
   - Home: Overall attendance percentage ring and recovery guidance.
   - Attendance: Monthly attendance calendar and subject-by-subject breakdown.
   - Requests: Attendance dispute/grievance timeline tracker and report sheet.
   - Profile: Biometric Face ID setup status and privacy standards.

3. **Admin Shell (`/(admin)`)**:
   - Home: Institutional metrics (attendance rate, active classes, operational alerts).
   - People: Student and faculty directory with teaching assignments.
   - Academics: Department overview and terms.
   - Settings: Biometric baseline configuration and device broadcast.

---

## Development

```bash
# Run tests
npm test

# Typecheck
npx tsc --noEmit

# Start development build
npx expo start
```
