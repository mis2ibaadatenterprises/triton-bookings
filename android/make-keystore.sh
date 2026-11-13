#!/usr/bin/env bash
# Creates the Android signing key for Triton and prints the three values to paste
# into GitHub as repository secrets. Run this ONCE, on a machine you control.
#
#   bash android/make-keystore.sh
#
# The key identifies the app to Android forever. If it is lost, this app can never
# be updated again — a new key means a new listing and a reinstall for every
# resident. Keep android.keystore and the password in a password manager.
set -euo pipefail

cd "$(dirname "$0")"
KS="android.keystore"

if [ -f "$KS" ]; then
  echo "$KS already exists here. Not overwriting it."
  echo "If you need the secrets again, re-run the two commands at the end of this script by hand."
  exit 1
fi

read -r -s -p "Choose a password for the signing key: " PW; echo
read -r -s -p "Type it again: " PW2; echo
[ "$PW" = "$PW2" ] || { echo "The two passwords differ."; exit 1; }
[ ${#PW} -ge 8 ] || { echo "Use at least 8 characters."; exit 1; }

keytool -genkeypair -v \
  -keystore "$KS" -alias triton \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PW" -keypass "$PW" \
  -dname "CN=Triton Clubhouse, OU=Committee, O=Raj Grandeur, L=, ST=, C=IN"

echo
echo "────────────────────────────────────────────────────────────────"
echo "Add these at:"
echo "  https://github.com/mis2ibaadatenterprises/triton-bookings/settings/secrets/actions"
echo
echo "  ANDROID_KEYSTORE_PASSWORD   the password you just chose"
echo "  ANDROID_KEY_PASSWORD        the same password"
echo "  ANDROID_KEYSTORE_BASE64     the block printed below"
echo "────────────────────────────────────────────────────────────────"
echo
base64 -w0 "$KS" 2>/dev/null || base64 "$KS"
echo
echo
echo "Key fingerprint (the release workflow publishes this for you):"
keytool -list -v -keystore "$KS" -alias triton -storepass "$PW" | grep "SHA256:"
echo
echo "Back up $KS somewhere safe now. It is deliberately not committed to git."
