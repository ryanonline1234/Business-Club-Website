import qr from 'qrcode';
import { SignJWT, jwtVerify } from 'jose';
import { AUTH_SECRET, SITE_URL } from './env';

// AUTH_SECRET is validated non-empty by ./env at module load. That check is
// the whole point: TextEncoder().encode(undefined) yields a zero-length key
// and jose signs HS256 with it WITHOUT throwing, which would make every
// check-in token forgeable by anyone.
const secret = new TextEncoder().encode(AUTH_SECRET);

const ALG = 'HS256';
const ISSUER = 'mbc';
const AUDIENCE = 'checkin';

/**
 * Token lifetime. Was 4 hours; a bearer token that anyone in the room can
 * photograph off a projector is the actual weakness, so the window is what
 * limits the blast radius.
 *
 * The client half lives in src/pages/calendar.astro's present mode: it reads
 * the `expires_in` this endpoint returns, silently re-fetches before expiry
 * (with a 30s retry on failure), and shows a refresh countdown — so a code
 * projected for a 45-minute meeting keeps verifying. If you change the TTL,
 * nothing client-side needs touching; it keys off `expires_in`. DO NOT
 * lengthen the TTL for convenience — the short window is the security
 * property.
 */
export const QR_TOKEN_TTL_SECONDS = 15 * 60;

export interface QRTokenPayload {
  event_id: string;
  /** Unique per token, so a specific projected code is identifiable in logs. */
  jti: string | null;
  /** Expiry as a Unix timestamp in seconds, or null if the claim was absent. */
  exp: number | null;
}

/**
 * Mint a signed check-in token for an event and render it as a QR data URL.
 *
 * `siteUrl` defaults to the validated SITE_URL. Note that the hostname is
 * baked into the encoded URL: after a SITE_URL cutover, every previously
 * printed or projected code points at the old host and must be regenerated.
 *
 * Callers must authorize first — only officers may mint tokens.
 */
export async function generateEventQR(
  eventId: string,
  siteUrl: string = SITE_URL
): Promise<string> {
  const url = `${siteUrl.replace(/\/+$/, '')}/checkin?token=${await signEventToken(eventId)}`;
  return await qr.toDataURL(url);
}

/** The raw signed token, without the QR rendering. */
export async function signEventToken(eventId: string): Promise<string> {
  return await new SignJWT({ event_id: eventId })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${QR_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

/**
 * Verify and decode a QR check-in token.
 * Returns null for anything invalid, expired, wrongly-signed, wrong issuer or
 * audience, signed with a different algorithm, or missing an event_id.
 *
 * `algorithms: ['HS256']` is pinned so a token with alg:'none' or an attacker-
 * chosen algorithm header can never be accepted.
 */
export async function verifyQRToken(token: string): Promise<QRTokenPayload | null> {
  if (!token || typeof token !== 'string') return null;

  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: [ALG],
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    const eventId = payload['event_id'];
    if (typeof eventId !== 'string' || eventId === '') return null;

    return {
      event_id: eventId,
      jti: typeof payload.jti === 'string' ? payload.jti : null,
      exp: typeof payload.exp === 'number' ? payload.exp : null,
    };
  } catch {
    return null;
  }
}
