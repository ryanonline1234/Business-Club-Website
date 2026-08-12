import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'server',
  adapter: vercel(),
  server: { port: 3000 },

  security: {
    // Astro 5 turns CSRF protection on by default, and its implementation
    // compares the `Origin` header against the *request URL* the handler sees.
    // Inside a Vercel serverless function that URL is NOT the public hostname
    // (this repo already hit that in commit 361927b — "Vercel reports localhost
    // as request origin"), so the comparison can never succeed and Astro
    // returns `Cross-site <METHOD> form submissions are forbidden` with a 403
    // before our own handler ever runs. That broke EVERY mutating request in
    // production: create/cancel event, approve member, post announcement, and
    // student check-in.
    //
    // Turning it off does not leave the app unprotected — it hands the job to
    // the check we already own, in `isCrossSiteRequest()` (src/lib/auth.ts),
    // which runs first inside every apiRequire* guard and in
    // checkSafeNavigation(). That one compares `Origin` against SITE_ORIGIN
    // (validated at boot in lib/env.ts) as well as the request's own origin,
    // and additionally rejects any request whose `Sec-Fetch-Site` is not
    // same-origin/none. On Vercel it is strictly more correct than Astro's,
    // because it knows the real public origin and Astro does not.
    //
    // If you ever re-enable this, every write path breaks again with a 403 and
    // no message in our logs, because the rejection happens above our code.
    checkOrigin: false,
  },
});
