// Entry module of client.html. Phones and tablets are not supported (the game needs a keyboard
// and mouse): on such a device this replaces the page with a notice and never loads client.js, so
// nothing else runs (no config, diagnostics or game) and nothing is uploaded. Otherwise it loads
// client.js as before.
// Keep the detection in step with site/lib/mobile.ts (launch page modal and the server-side check
// in site/proxy.ts).

export function isMobileDevice(nav = globalThis.navigator, media = globalThis.matchMedia) {
  if (!nav) return false;
  if (nav.userAgentData?.mobile === true) return true;
  const ua = String(nav.userAgent || '');
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile|webOS/i.test(ua)) return true;
  // iPadOS reports a desktop Mac user agent; a "Mac" with a touch screen is an iPad.
  if (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) return true;
  // Touch-only devices (desktop-mode tablet browsers): a coarse pointer and no mouse or trackpad.
  try {
    return !!media && media('(any-pointer: coarse)').matches && !media('(any-pointer: fine)').matches;
  } catch {
    return false;
  }
}

if (isMobileDevice()) {
  globalThis.__eaglerDeviceBlocked = true;
  const page = document.createElement('main');
  page.setAttribute('role', 'alert');
  page.style.cssText = 'max-width:32rem;margin:15vh auto;padding:0 16px;font:16px/1.5 system-ui,sans-serif;color:#e8e6e1;text-align:center';
  page.innerHTML = '<h1 style="font-size:1.5rem;margin:0 0 12px">Not available on mobile</h1>' +
    '<p>Eagler26 needs a computer with a keyboard and mouse. Phones and tablets aren\'t supported, so the game ' +
    'won\'t start on this device.</p><p>Open it on a desktop or laptop to play.</p>' +
    '<p><a href="/" style="color:#cfe3ff">Back to Eagler26</a></p>';
  document.documentElement.style.background = '#0f0e0c';
  document.body.replaceChildren(page);
} else {
  await import('./client.js?v=0.9900');
}
