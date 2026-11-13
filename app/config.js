/* Triton — deployment configuration.
   The app reads and writes through the Google Sheet "Triton Bookings — data",
   via the Apps Script web app deployed from it. Put that /exec URL below and
   every phone shares the same bookings. Left empty, the app runs in demo mode
   with data kept in one browser, which is only useful for a demonstration. */
window.TRITON_CONFIG = {
  PROPERTY_NAME: "Triton",

  /* The Apps Script web app URL, ending in /exec. Paste it here after deploying
     the script from the "Triton Bookings — data" sheet. Until it is filled in,
     the app runs in demo mode with data kept in the browser only. */
  SHEETS_API_URL: "https://script.google.com/macros/s/AKfycbyDFot93XsndmdrlOIjFRmkB2U4DJAa5TFpFRrhaU7VDCwozAnyfJzjrKSCiyiSMZOT0Q/exec",

  /* Hours a resident has to upload payment proof after approval. */
  PAYMENT_WINDOW_HOURS: 48,

  /* Shown to the resident on the approval notice. */
  PAYMENT_UPI: "trisoc@upi",
  PAYMENT_NOTE: "Add the booking number in the payment remark."
};
