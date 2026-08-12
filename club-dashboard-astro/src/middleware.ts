import type { MiddlewareHandler } from 'astro';

/**
 * The page guards in src/lib/auth.ts (requireSession / requireApproved /
 * requireOfficer) THROW an Astro.redirect Response from page frontmatter.
 * Astro 5 only honors a *returned* Response from frontmatter
 * (runtime/server/render/astro/render.js checks `factoryResult instanceof
 * Response`); a thrown one falls through to the generic error handler in
 * core/app/index.js and renders the 500 page. So without this middleware a
 * signed-out visitor to any guarded page gets an error page instead of the
 * /login redirect.
 *
 * Catching here is safe: the guards throw during frontmatter, which runs to
 * completion before the response stream is constructed, so nothing has been
 * written to the client when the Response surfaces.
 */
export const onRequest: MiddlewareHandler = async (_context, next) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
};
