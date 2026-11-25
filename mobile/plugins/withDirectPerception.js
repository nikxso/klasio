const {
  withAppBuildGradle,
  withMainApplication,
  withDangerousMod,
  createRunOncePlugin,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const ONNX_DEPENDENCY = 'implementation("com.microsoft.onnxruntime:onnxruntime-android:1.20.0")';
const PACKAGE_IMPORT = 'import com.klasio.app.perception.DirectPerceptionPackage';

/**
 * Add ONNX Runtime Android dependency to app/build.gradle
 */
function addOnnxDependency(buildGradle) {
  if (buildGradle.includes('com.microsoft.onnxruntime:onnxruntime-android')) {
    return buildGradle;
  }
  return buildGradle.replace(
    /dependencies\s*\{/,
    `dependencies {\n    // ONNX Runtime Android for on-device neural perception\n    ${ONNX_DEPENDENCY}`
  );
}

/**
 * Register DirectPerceptionPackage in MainApplication.kt
 */
function modifyMainApplication(mainApplication) {
  let content = mainApplication;

  // Add import if missing (after package statement)
  if (!content.includes(PACKAGE_IMPORT)) {
    content = content.replace(
      /(package\s+[^\n]+)/,
      `$1\n\n${PACKAGE_IMPORT}`
    );
  }

  // Register package in reactHost packageList
  if (!content.includes('add(DirectPerceptionPackage())')) {
    if (content.includes('PackageList(this).packages.apply {')) {
      content = content.replace(
        'PackageList(this).packages.apply {',
        'PackageList(this).packages.apply {\n          add(DirectPerceptionPackage())'
      );
    } else {
      content = content.replace(
        'PackageList(this).packages',
        'PackageList(this).packages.apply {\n          add(DirectPerceptionPackage())\n        }'
      );
    }
  }

  return content;
}

/**
 * Copy native Kotlin files and neural model assets
 */
async function copyNativeFilesAndAssets(config) {
  const projectRoot = config.modRequest.projectRoot;
  const platformRoot = config.modRequest.platformProjectRoot;

  // 1. Copy Kotlin perception package files
  const nativeSrcDir = path.join(
    projectRoot,
    'native/android/src/main/java/com/klasio/app/perception'
  );
  const destSrcDir = path.join(
    platformRoot,
    'app/src/main/java/com/klasio/app/perception'
  );

  if (fs.existsSync(nativeSrcDir)) {
    fs.mkdirSync(destSrcDir, { recursive: true });
    const files = fs.readdirSync(nativeSrcDir);
    for (const file of files) {
      if (file.endsWith('.kt') || file.endsWith('.java')) {
        fs.copyFileSync(
          path.join(nativeSrcDir, file),
          path.join(destSrcDir, file)
        );
      }
    }
  }

  // 2. Copy ONNX models to android assets
  const nativeModelsDir = path.join(
    projectRoot,
    'native/android/assets/models'
  );
  const destModelsDir = path.join(
    platformRoot,
    'app/src/main/assets/models'
  );

  if (fs.existsSync(nativeModelsDir)) {
    fs.mkdirSync(destModelsDir, { recursive: true });
    const models = fs.readdirSync(nativeModelsDir);
    for (const model of models) {
      if (model.endsWith('.onnx')) {
        fs.copyFileSync(
          path.join(nativeModelsDir, model),
          path.join(destModelsDir, model)
        );
      }
    }
  }

  // 3. Ensure local.properties has sdk.dir if available
  const localPropsPath = path.join(platformRoot, 'local.properties');
  const defaultSdk = '/home/dope/Android/Sdk';
  const sdkDir =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (fs.existsSync(defaultSdk) ? defaultSdk : null);
  if (sdkDir && !fs.existsSync(localPropsPath)) {
    fs.writeFileSync(localPropsPath, `sdk.dir=${sdkDir}\n`);
  }

  // 4. Ensure JDK 17 with javac is used if default system Java lacks compiler
  const gradlePropsPath = path.join(platformRoot, 'gradle.properties');
  const jdkHome = '/home/dope/.gradle/jdks/eclipse_adoptium-17-amd64-linux.2';
  if (fs.existsSync(jdkHome) && fs.existsSync(gradlePropsPath)) {
    let props = fs.readFileSync(gradlePropsPath, 'utf8');
    if (!props.includes('org.gradle.java.home')) {
      props += `\norg.gradle.java.home=${jdkHome}\n`;
      fs.writeFileSync(gradlePropsPath, props);
    }
  }

  // 5. Ensure ProGuard / R8 rules for ONNX Runtime & VisionCamera
  const proguardPath = path.join(platformRoot, 'app/proguard-rules.pro');
  if (fs.existsSync(proguardPath)) {
    let proguard = fs.readFileSync(proguardPath, 'utf8');
    const rules = [
      '-keep class ai.onnxruntime.** { *; }',
      '-dontwarn ai.onnxruntime.**',
      '-keep class com.klasio.app.perception.** { *; }',
      '-keep class com.mrousavy.camera.** { *; }',
      '-dontwarn com.mrousavy.camera.**',
    ];
    let modified = false;
    for (const rule of rules) {
      if (!proguard.includes(rule)) {
        proguard += `\n${rule}`;
        modified = true;
      }
    }
    if (modified) {
      fs.writeFileSync(proguardPath, proguard);
    }
  }

  return config;
}

const withDirectPerception = (config) => {
  // 1. Modify build.gradle
  config = withAppBuildGradle(config, (gradleConfig) => {
    gradleConfig.modResults.contents = addOnnxDependency(
      gradleConfig.modResults.contents
    );
    return gradleConfig;
  });

  // 2. Modify MainApplication.kt
  config = withMainApplication(config, (appConfig) => {
    appConfig.modResults.contents = modifyMainApplication(
      appConfig.modResults.contents
    );
    return appConfig;
  });

  // 3. Copy Kotlin sources & assets
  config = withDangerousMod(config, [
    'android',
    async (dangerConfig) => {
      await copyNativeFilesAndAssets(dangerConfig);
      return dangerConfig;
    },
  ]);

  return config;
};

module.exports = createRunOncePlugin(
  withDirectPerception,
  'withDirectPerception',
  '1.0.0'
);
