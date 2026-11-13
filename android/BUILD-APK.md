# Building the Triton APK

The app is a Trusted Web Activity: a thin Android shell around the live site.
The shell holds no screens of its own, so **you rebuild the APK only to change the
icon, the name or the version. Every other change ships by pushing to `main`.**

This has to run on your own machine — the Android SDK is not reachable from the
environment where the project was built.

## Once, to set up

Requires Node 18+ and a JDK (17 or newer).

```bash
cd android-app
gradle wrapper --gradle-version 8.7
```

You need the Android SDK (Android Studio installs it) and a JDK 17.

### Create the signing key

```bash
keytool -genkeypair -v \
  -keystore android.keystore -alias triton \
  -keyalg RSA -keysize 2048 -validity 10000
```

**Keep `android.keystore` and its password in a password manager.** Lose them and
this app can never be updated again — you would have to publish a new listing and
ask every resident to reinstall. Do not commit the keystore to the repository.

### Link the key to the website

Print the fingerprint:

```bash
keytool -list -v -keystore android.keystore -alias triton | grep SHA256
```

Put that value into `app/.well-known/assetlinks.json`, replacing
`REPLACE_WITH_YOUR_SIGNING_KEY_SHA256_FINGERPRINT`, then commit and push. Without
this, the app opens with a browser address bar across the top instead of looking
like a native app.

## Every build

```bash
cd android-app
./gradlew :app:assembleRelease :app:bundleRelease \
  -PtritonVersionName=1.0.0 -PtritonVersionCode=2 \
  -PtritonKeystore="$PWD/../android/android.keystore" \
  -PtritonStorePassword=... -PtritonKeyPassword=...
```

Produces `app/build/outputs/apk/release/app-release.apk` to sideload and
`app/build/outputs/bundle/release/app-release.aab` for Play. Raise
`tritonVersionCode` on every Play upload — Play rejects a repeat.

Normally you do not run any of this by hand: the release workflow does it on
GitHub's runners whenever you start it from the Actions tab.

## Getting it onto residents' phones

**Play Store closed testing — recommended.** Residents join with a link and get
updates silently.

1. Create a developer account at <https://play.google.com/console> — USD 25, once.
   An organisation account also needs business verification; allow two to three weeks.
2. Create the app, upload `app-release-bundle.aab` to **Testing → Closed testing**.
3. Add residents' Google addresses to the tester list, or use the email-list option,
   and send them the opt-in link.
4. Fill in the data safety form. Declare what you actually collect: flat number,
   name, phone, and payment screenshots.

**Sideloading the APK over WhatsApp** works for a quick trial, but every resident
sees an "unknown sources" warning, and there is no update channel — they would have
to reinstall by hand each time. Use it for testing with two or three people, not for
the whole society.

## iPhone

No build and no store. Residents open
<https://mis2ibaadatenterprises.github.io/triton-bookings/> in **Safari** (it must be
Safari, not Chrome), tap Share, then **Add to Home Screen**. It then opens full
screen with the Triton icon and tracks the live site, so updates are automatic.

Notifications on iOS only work after Add to Home Screen, and only if the resident
allows them. Treat SMS or WhatsApp as the real channel for the 48-hour payment
reminder.

An App Store listing is only worth it if you need Apple Pay — USD 99 a year and a
review on every release, which removes the automatic updates.
