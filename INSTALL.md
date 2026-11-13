# Getting Triton onto phones

Paste the relevant block into your setup message. The download links below always
give the newest build, so they do not go out of date.

---

## Android

The best way to get it onto a phone is to open this link on the phone itself:

https://github.com/mis2ibaadatenterprises/triton-bookings/releases/latest/download/Triton.apk

1. Open the link above on the phone and download the file.
2. Tap the downloaded **Triton.apk**. If Android asks, allow your browser to install apps.
3. Open the app and sign in — **Resident** tab, your flat number and PIN.

Phones that already have the app do not need this. They pick up changes the next
time they open it, and show an **Update bar** inside the app if it is already open.

## iPhone

No download and no App Store. Open this link in **Safari**:

https://mis2ibaadatenterprises.github.io/triton-bookings/

Tap **Share → Add to Home Screen**. It then opens full screen with the Triton icon
and updates itself every time it is opened.

It must be Safari. Chrome on iPhone cannot add a site to the Home Screen.

## Windows

https://github.com/mis2ibaadatenterprises/triton-bookings/releases/latest/download/Triton-Setup-1.0.0.exe

Windows may block this installer, as Smart App Control does with any installer that
is not code-signed. If that happens, open the iPhone link above in **Edge** and use
**Install this site as an app** — it works the same way and needs no installer.

The version number is in the Windows file name, so update that line when you cut a
new release. The Android and iPhone links never change.

---

# Cutting a release

Once, before the first release — create the signing key and add the secrets it prints:

```bash
bash android/make-keystore.sh
```

Then for every release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

That builds and publishes, in about 8 minutes:

| File | What it is |
|---|---|
| `Triton.apk` | What residents install on Android. Name never changes. |
| `Triton-Setup-<version>.exe` | Windows installer. |
| `Triton-play-<version>.aab` | For uploading to the Play Console. Not for phones. |

You only need a new release to change the app's icon, name, or the Windows shell.
**Everything inside the app ships by pushing to `main`** — the Android and Windows
apps are thin shells around the live site, so they show the new version on the next
open without anybody reinstalling.
