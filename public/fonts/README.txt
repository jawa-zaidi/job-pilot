Instrument Sans and Instrument Serif
====================================

Both typefaces are licensed under the SIL Open Font License 1.1, which permits
bundling them with an application. They are shipped here rather than loaded from
Google Fonts on purpose: JobPilot is a local-first app that has to look right
with the network unplugged, and a CDN link would also leak one request to
Google on every single launch.

Files (latin + latin-ext subsets, taken from the Google Fonts CDN):

  instrument-sans-latin.woff2       Instrument Sans, variable weight 400–700
  instrument-sans-latin-ext.woff2   ditto, latin-ext range
  instrument-serif-latin.woff2      Instrument Serif, weight 400
  instrument-serif-latin-ext.woff2  ditto, latin-ext range

The matching @font-face rules live at the top of public/styles.css. If these
files are ever missing the app falls back to the system stack declared there and
still looks fine — only the typeface changes.

Upstream: https://fonts.google.com/specimen/Instrument+Sans
          https://fonts.google.com/specimen/Instrument+Serif
License:  https://openfontlicense.org (OFL 1.1)
