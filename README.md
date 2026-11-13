# Triton — clubhouse bookings

Amenity booking app for Raj Grandeur's Triton clubhouse. Two dashboards behind one
login screen: residents book and pay, the committee approves, verifies and runs the
register.

**Live site:** https://mis2ibaadatenterprises.github.io/triton-bookings/

## What it does

| | Resident | Committee |
|---|---|---|
| See the availability calendar | yes | yes |
| Request a slot | own flat | any flat |
| Approve or reject | — | yes |
| Upload payment picture | own booking | on behalf |
| Verify payment, confirm | — | yes |
| Override the 48-hour clock | — | yes |
| See other flats' details | — | yes |
| Day-view occupancy sheet | — | yes |

Spaces and slot shapes:

| Space | Slot | Charge |
|---|---|---|
| Banquet Hall | 1st half (09–15) / 2nd half (16–23) | ₹15,000 per half-day |
| Terrace | 1st half / 2nd half | ₹9,000 per half-day |
| Meeting Room 1 / 2 / 3 | hourly, 09:00–21:00 | ₹400 / ₹500 / ₹700 per hour |
| The Den | 3-hour slots | ₹1,200 |
| Home Theatre | 5-hour slots | ₹2,500 |
| Golf Room | 2-hour slots | ₹1,500 |

Rates and hours live at the top of `app/app.js` in `FACILITIES`. Change them there.

## The booking flow

1. **Date block request** — resident picks space, date, slots. The slot is held.
2. **Approval** — committee approves; a 48-hour payment clock starts.
3. **Payment picture upload** — resident uploads the UPI/NEFT receipt.
4. **Confirmed** — committee checks it against the bank and locks the slot.

If no payment picture arrives within 48 hours of approval the booking auto-cancels
and the slot returns to the calendar. The app sweeps for this while it is open;
`expire_unpaid_bookings()` in the schema does it server-side on a schedule, so the
rule holds even when nobody has the app open.

## Running it

The app works immediately in **demo mode** — no server, data in the browser only.
Useful for showing the committee. Logins:

- Resident `B-1204` / `1204`
- Committee `desk.manager` / `triton`

For real use with many phones you need a shared database. Setup is about 20 minutes:

1. Create a free project at <https://supabase.com>.
2. Paste `supabase/schema.sql` into the SQL editor and run it.
3. Copy the project URL and the **anon** key (Settings → API) into `app/config.js`.
4. Create the logins as described at the bottom of `schema.sql`.
5. Commit and push. The site redeploys and every phone switches to the shared data.

Never put the `service_role` key in `app/config.js` — that file is public.

## Logins

One account per flat; the flat number is the login and the billing identity. Up to
four member profiles can share a flat account. Committee members each get their own
ID so approvals are attributable — avoid a shared desk account.

For 300 flats: 300 flat accounts, up to 1,200 member profiles, 4 to 6 committee
logins, and optionally one read-only gate login.

No cap on simultaneous users. Peak for a society this size is 30 to 60 at once,
usually the evening a festival calendar opens. The `slot_locks` table is what stops
two residents winning the same slot in the same second.

## Auto-update

Pushing to `main` runs `.github/workflows/pages.yml`, which redeploys the site and
stamps the commit into the service worker's cache name. Phones fetch the shell
network-first, so:

- **Closed app** → next open is already the new version.
- **Open app** → a bar appears offering the reload, and the app checks again every
  time it returns to the foreground.

The Android shell is a Trusted Web Activity pointing at this site, so it updates the
same way. You only rebuild the APK to change the icon, name or notification setup.

## Phones

- **Android** — install link and release steps are in `INSTALL.md`; `android/BUILD-APK.md` covers building by hand.
  the Play bundle. Distribute through a Play closed testing track.
- **iPhone** — open the site in Safari, Share → Add to Home Screen. No build, no
  store, automatic updates.

## Layout

```
app/                  the website; this folder is what GitHub Pages serves
  index.html          login screen and app shell, service-worker registration
  styles.css          the whole design system
  app.js              both dashboards, booking flow, 48-hour clock
  data.js             demo and Supabase backends behind one API
  config.js           property name, Supabase keys, payment details
  sw.js               network-first service worker
  manifest.webmanifest, icons/
  .well-known/assetlinks.json   links the Android app to this site
supabase/schema.sql   tables, slot-collision guard, row-level security, storage
android/              Bubblewrap config and the APK build guide
```

## Still to decide

- Real rates and operating hours.
- The society's UPI handle (`PAYMENT_UPI` in `app/config.js`, currently a placeholder).
- Whether security gets the read-only gate login.
