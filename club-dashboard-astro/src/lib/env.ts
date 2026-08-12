/**
 * Environment validation — the app's boot check.
 *
 * WHY THIS FILE EXISTS
 *   `new TextEncoder().encode(import.meta.env.AUTH_SECRET)` returns a
 *   zero-length Uint8Array when AUTH_SECRET is unset, and jose signs HS256
 *   with an empty key WITHOUT throwing. Every check-in token would then be
 *   forgeable by anyone, silently, in production. A deploy that cannot sign
 *   tokens must fail loudly at boot instead.
 *
 *   Importing this module validates all five variables once, at module load.
 *   lib/supabase.ts and lib/qrcode.ts both import it, so any route that can
 *   reach a database or mint a token has already run the check.
 *
 * EVERY value is .trim()ed. Values pasted into the Vercel dashboard routinely
 * carry a trailing newline; an untrimmed service-role key produces a 401 from
 * PostgREST that looks nothing like "you have a newline in your env var".
 */

const REQUIRED_KEYS = [
  'PUBLIC_SUPABASE_URL',
  'PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'AUTH_SECRET',
  'SITE_URL',
] as const;

type RequiredKey = (typeof REQUIRED_KEYS)[number];

/** What breaks when each one is missing — printed in the boot error. */
const WHY_IT_MATTERS: Record<RequiredKey, string> = {
  PUBLIC_SUPABASE_URL: 'the Supabase project URL — nothing can reach the database without it',
  PUBLIC_SUPABASE_ANON_KEY: 'the anon key used by the cookie-aware SSR client that reads the session',
  SUPABASE_SERVICE_ROLE_KEY: 'the service-role key every server query runs through',
  AUTH_SECRET:
    'the HMAC key for QR check-in tokens — if it is empty, jose signs with a zero-length key and every token is forgeable',
  SITE_URL:
    'the canonical origin, used for the OAuth redirect target, the URL inside QR codes, and the CSRF origin check',
};

/**
 * HOW VALUES ARE READ, AND WHY IT LOOKS LIKE THIS
 *
 *   process.env is the ONLY source consulted in a production build. That is the
 *   runtime truth on Vercel, and reading it means a deploy whose runtime
 *   environment is missing AUTH_SECRET throws here at boot — which is the entire
 *   promise this file makes.
 *
 *   ⚠ DO NOT touch the bare `import.meta.env` OBJECT (no `import.meta.env[key]`,
 *   no `{...import.meta.env}`, no `const e = import.meta.env`). Vite compiles a
 *   bare reference into `Object.assign(__vite_import_meta_env__, { …every
 *   loaded variable as a string literal… })`, which SERIALISES THE SERVICE-ROLE
 *   KEY AND AUTH_SECRET INTO THE SERVER BUNDLE. Two things then break:
 *     1. the boot check cannot fail, because the build-time literal is always
 *        there — a deploy with no runtime AUTH_SECRET silently signs check-in
 *        tokens with whatever was in the developer's .env at build time;
 *     2. `vercel deploy --prebuilt` ships that .env inside the function bundle.
 *   This was real: it was verified in `.vercel/output/_functions/chunks/`.
 *
 *   The dev fallback below is therefore written as STATIC member accesses
 *   (`import.meta.env.AUTH_SECRET`), each one behind `import.meta.env.DEV`.
 *   Vite replaces DEV with the literal `false` in a build and Rollup drops the
 *   branch, so no secret literal survives. If you edit this function, rebuild
 *   and grep `.vercel/output` for your AUTH_SECRET before you push.
 *
 * Empty and whitespace-only values count as missing.
 */
const processEnv: Record<string, string | undefined> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * `astro dev` loads .env into import.meta.env only — it does NOT populate
 * process.env (verified against this repo's Astro 5). Without this branch there
 * is no local development at all. It is compiled out of production builds.
 */
function readDevFallback(key: RequiredKey): string {
  if (!import.meta.env.DEV) return '';

  switch (key) {
    case 'PUBLIC_SUPABASE_URL':
      return typeof import.meta.env.PUBLIC_SUPABASE_URL === 'string'
        ? import.meta.env.PUBLIC_SUPABASE_URL
        : '';
    case 'PUBLIC_SUPABASE_ANON_KEY':
      return typeof import.meta.env.PUBLIC_SUPABASE_ANON_KEY === 'string'
        ? import.meta.env.PUBLIC_SUPABASE_ANON_KEY
        : '';
    case 'SUPABASE_SERVICE_ROLE_KEY':
      return typeof import.meta.env.SUPABASE_SERVICE_ROLE_KEY === 'string'
        ? import.meta.env.SUPABASE_SERVICE_ROLE_KEY
        : '';
    case 'AUTH_SECRET':
      return typeof import.meta.env.AUTH_SECRET === 'string' ? import.meta.env.AUTH_SECRET : '';
    case 'SITE_URL':
      return typeof import.meta.env.SITE_URL === 'string' ? import.meta.env.SITE_URL : '';
    default:
      return '';
  }
}

function read(key: RequiredKey): string {
  const fromProcess = processEnv[key];
  if (typeof fromProcess === 'string' && fromProcess.trim() !== '') return fromProcess.trim();

  const fromDev = readDevFallback(key);
  if (fromDev.trim() !== '') return fromDev.trim();

  return '';
}

const values = {} as Record<RequiredKey, string>;
const missing: RequiredKey[] = [];

for (const key of REQUIRED_KEYS) {
  const value = read(key);
  if (value === '') missing.push(key);
  values[key] = value;
}

if (missing.length > 0) {
  throw new Error(
    [
      `[env] Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
      '',
      ...missing.map((key) => `  • ${key} — ${WHY_IT_MATTERS[key]}`),
      '',
      `Set ${missing.length > 1 ? 'them' : 'it'} in club-dashboard-astro/.env for local development, and in the`,
      'Vercel project settings (Production AND Preview) for deploys. Values must',
      'be non-empty after trimming — a variable set to "" is treated as missing.',
      'The app refuses to start rather than run with a broken configuration.',
    ].join('\n')
  );
}

/** Fail loudly on a malformed SITE_URL rather than at the first redirect. */
function parseOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    throw new Error(
      `[env] SITE_URL is not a valid absolute URL: ${JSON.stringify(rawUrl)}. ` +
        'It must include the scheme, e.g. https://mittybusinessclub.vercel.app'
    );
  }
}

export const PUBLIC_SUPABASE_URL: string = values.PUBLIC_SUPABASE_URL;
export const PUBLIC_SUPABASE_ANON_KEY: string = values.PUBLIC_SUPABASE_ANON_KEY;
export const SUPABASE_SERVICE_ROLE_KEY: string = values.SUPABASE_SERVICE_ROLE_KEY;
export const AUTH_SECRET: string = values.AUTH_SECRET;

/** Canonical site URL, trailing slash stripped so `${SITE_URL}/login` is safe. */
export const SITE_URL: string = values.SITE_URL.replace(/\/+$/, '');

/** Scheme + host + port of SITE_URL. Used by the API CSRF origin check. */
export const SITE_ORIGIN: string = parseOrigin(SITE_URL);

// Not fatal: an existing deploy with a short secret should keep working, but
// HS256 wants at least 32 bytes of key material.
if (AUTH_SECRET.length < 32) {
  console.warn(
    `[env] AUTH_SECRET is only ${AUTH_SECRET.length} characters. HS256 expects at least 32; ` +
      'generate a stronger one with `openssl rand -base64 48`.'
  );
}

/** Everything in one object, for callers that prefer a namespace. */
export const env = {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  AUTH_SECRET,
  SITE_URL,
  SITE_ORIGIN,
} as const;

/**
 * The only place the school-domain rule lives in TypeScript.
 * Mirrored in SQL by public.is_school_email() (STEP 8 of supabase-schema.sql).
 * Students are @mittymonarch.com, faculty are @mitty.com.
 */
export const SCHOOL_EMAIL_DOMAINS = ['mittymonarch.com', 'mitty.com'] as const;

export type SchoolEmailDomain = (typeof SCHOOL_EMAIL_DOMAINS)[number];

/**
 * True when `email`'s domain is a school domain. Case-insensitive, tolerant of
 * surrounding whitespace, false for null/undefined/malformed input.
 *
 * Deliberately identical to split_part(addr, '@', 2) in SQL: for the malformed
 * address "a@b@c" both take "b". Keeping the two implementations bug-compatible
 * matters more than either being clever.
 */
export function isSchoolEmail(email: string | null | undefined): boolean {
  const domain = (email ?? '').trim().toLowerCase().split('@')[1] ?? '';
  return (SCHOOL_EMAIL_DOMAINS as readonly string[]).includes(domain);
}
