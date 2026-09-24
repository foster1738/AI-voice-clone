// After `npx cap add ios|android`, adds the microphone permissions the app
// needs. Safe to run repeatedly (npm run mobile:sync does it for you).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const plist = 'ios/App/App/Info.plist';
if (existsSync(plist)) {
  let s = readFileSync(plist, 'utf8');
  if (!s.includes('NSMicrophoneUsageDescription')) {
    s = s.replace(
      /<dict>/,
      '<dict>\n\t<key>NSMicrophoneUsageDescription</key>\n\t<string>VoxMorph uses the microphone to change your voice.</string>\n\t<key>UIBackgroundModes</key>\n\t<array><string>audio</string></array>',
    );
    writeFileSync(plist, s);
    console.log('iOS: microphone permission added');
  }
}

const manifest = 'android/app/src/main/AndroidManifest.xml';
if (existsSync(manifest)) {
  let s = readFileSync(manifest, 'utf8');
  const perms = ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS'];
  let changed = false;
  for (const p of perms) {
    if (!s.includes(p)) {
      s = s.replace('</manifest>', `    <uses-permission android:name="${p}" />\n</manifest>`);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(manifest, s);
    console.log('Android: microphone permissions added');
  }
}
