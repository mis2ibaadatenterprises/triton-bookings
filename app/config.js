/* Triton — deployment configuration.
   Leave SUPABASE_URL empty to run in on-device demo mode (data stays in this browser).
   Fill both values after creating a Supabase project to switch the whole app to the
   shared database: every phone then sees the same bookings. The anon key is a public
   key by design — row-level security in supabase/schema.sql is what protects the data.
   Never put the service_role key in this file. */
window.TRITON_CONFIG = {
  PROPERTY_NAME: "Triton",
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  /* Synthetic email domain used to turn a flat number into a Supabase Auth account.
     B-1204 becomes b-1204@triton.invalid. Keep ".invalid" — it is reserved and
     unroutable, so no mail can ever be sent to it. */
  AUTH_EMAIL_DOMAIN: "triton.invalid",

  /* Hours a resident has to upload payment proof after approval. */
  PAYMENT_WINDOW_HOURS: 48,

  /* Shown to the resident on the approval notice. */
  PAYMENT_UPI: "trisoc@upi",
  PAYMENT_NOTE: "Add the booking number in the payment remark."
};
