// Shared-password gate for the whole site (Cloudflare Pages Functions middleware).
// The password lives in the Pages secret SITE_PASSWORD, never in this repo.
// A correct password sets a long-lived cookie holding a hash of it, so changing
// the secret logs every device out.

const COOKIE = 'sb_auth';
const MAX_AGE = 60 * 60 * 24 * 365; // a year: the home-screen app shouldn't keep asking
// Fetched by iOS / browsers outside the page's cookie context, and harmless to expose.
const PUBLIC = new Set(['/manifest.webmanifest', '/apple-touch-icon.png', '/icon-512.png', '/icon.svg']);

async function tokenFor(password) {
  const bytes = new TextEncoder().encode('supper-board:' + password);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function loginPage(wrong) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Supper Board">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<title>Supper Board</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbf6ef;color:#2b2420;
       font:17px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  form{width:min(320px,86vw);text-align:center}
  img{width:72px;height:72px;border-radius:16px}
  h1{font-size:22px;margin:14px 0 18px}
  input{box-sizing:border-box;width:100%;padding:13px 14px;font-size:17px;border:1px solid #d9cfc4;border-radius:12px;background:#fff}
  button{margin-top:12px;width:100%;padding:13px;font-size:17px;font-weight:600;border:0;border-radius:12px;background:#c8553d;color:#fff}
  p{color:#b3261e;margin:10px 0 0;font-size:15px}
</style></head>
<body><form method="post" action="/__login">
<img src="/apple-touch-icon.png" alt="">
<h1>Supper Board</h1>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button type="submit">Open</button>
${wrong ? '<p>That\'s not it - try again.</p>' : ''}
</form></body></html>`;
  return new Response(html, {
    status: wrong ? 401 : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const password = env.SITE_PASSWORD;
  if (!password) return new Response('Site password not configured', { status: 503 });
  const expected = await tokenFor(password);

  if (url.pathname === '/__login' && request.method === 'POST') {
    const form = await request.formData();
    if ((await tokenFor(String(form.get('password') || '').trim().toLowerCase())) !== (await tokenFor(password.toLowerCase()))) {
      return loginPage(true);
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: '/',
        'Set-Cookie': `${COOKIE}=${expected}; Max-Age=${MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (PUBLIC.has(url.pathname)) return next();
  if (readCookie(request, COOKIE) === expected) return next();
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'sign in first' }), {
      status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return loginPage(false);
}
