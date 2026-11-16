// /recipe/<id> for recipes added on the board or by an agent (custom-/web- ids). They live in KV and have no static file,
// so this renders the same page as the static ones (site/recipe-page.js), with the schema.org Recipe JSON-LD in the server
// HTML so Safari's cooking view on HomeView can read it. Runs behind functions/_middleware.js (the password gate).
// Any other id falls through to the static file site/recipe/<id>.html.
import { loadRecipes } from '../api/state.js';
import { customToRecipe } from '../../site/shortlist.js';
import { recipePage, recipeCsp, pageProblem } from '../../site/recipe-page.js';

const CUSTOM_ID = /^(web|custom)-[A-Za-z0-9_-]{3,60}$/;

export async function onRequestGet(context) {
  const { params, env, next, request } = context;
  const id = String(params.id || '').replace(/\.html$/, '');
  if (!CUSTOM_ID.test(id)) return next();
  const saved = (await loadRecipes(env)).map.get(id);
  const r = saved && customToRecipe(saved);
  if (!r || pageProblem(r)) {
    return new Response('<!doctype html><meta charset="utf-8"><title>Not found · HelloSupper</title><p>No such recipe. <a href="/#library">Open the Library</a></p>',
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return new Response(recipePage(r, new URL(request.url).origin), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': recipeCsp(r) + "; frame-ancestors 'none'",
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
