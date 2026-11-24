#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
sdk="${ANDROID_SDK_ROOT:?Set ANDROID_SDK_ROOT to the Android SDK directory}"
tools="$sdk/build-tools/35.0.0"
platform="$sdk/platforms/android-35/android.jar"
output="${1:?Pass the desired APK output path}"
keystore="${MP_READER_KEYSTORE:?Set MP_READER_KEYSTORE to the signing keystore}"
key_alias="${MP_READER_KEY_ALIAS:-mp-reader}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

npm run build
mkdir -p "$work"/{assets/web,generated,classes,dex}
cp -R dist/. "$work/assets/web/"
"$tools/aapt2" compile --dir android/res -o "$work/resources.zip"
"$tools/aapt2" link -I "$platform" --manifest android/AndroidManifest.xml \
  -A "$work/assets" --java "$work/generated" -o "$work/base.apk" "$work/resources.zip"
sources=(android/ReaderActivity.java "$work/generated/app/mpreader/sync2/R.java")
if [ -n "${MP_READER_ECJ_JAR:-}" ]; then
  java -jar "$MP_READER_ECJ_JAR" -8 -proc:none -bootclasspath "$platform:$tools/core-lambda-stubs.jar" -d "$work/classes" "${sources[@]}"
else
  javac --release 8 -classpath "$platform" -d "$work/classes" "${sources[@]}"
fi
(cd "$work/classes" && zip -qr "$work/classes.jar" .)
"$tools/d8" --min-api 30 --lib "$platform" --output "$work/dex" "$work/classes.jar"
(cd "$work/dex" && zip -q "$work/base.apk" classes.dex)
"$tools/zipalign" -f 4 "$work/base.apk" "$work/aligned.apk"
"$tools/apksigner" sign --ks "$keystore" --ks-key-alias "$key_alias" \
  --ks-pass env:MP_READER_KEYSTORE_PASSWORD --out "$output" "$work/aligned.apk"
"$tools/apksigner" verify "$output"
