// Loading screen shown by client.html until the game draws its first frame. It shows the startup
// stage, download progress (the Wasm module is ~95 MB) and elapsed time, and turns into an error
// panel when startup fails, so a slow or broken start is never just a blank page.
// client.js drives it through the returned object; downloads are counted by wrapping fetch() for
// the game's own files while startup runs.

const root = () => document.getElementById('boot-screen');
const $ = id => document.getElementById(id);
const mb = bytes => (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1);

// Share of the whole bar per step; download steps fill their share by bytes.
const STEPS = {storage: [0, 2], runtime: [2, 4], wasm: [4, 72], compile: [72, 80], assets: [80, 92], start: [92, 100]};

export function createBootScreen() {
  const el = root();
  const startedAt = performance.now();
  const downloads = new Map();
  let step = 'storage', label = 'Opening storage', fraction = 0, detail = '', failed = false, done = false;

  const render = () => {
    if (!el || done) return;
    const [from, to] = STEPS[step] || [0, 100];
    const pct = Math.max(0, Math.min(100, from + (to - from) * Math.max(0, Math.min(1, fraction))));
    $('boot-bar-fill').style.width = `${pct.toFixed(1)}%`;
    $('boot-status').textContent = label;
    $('boot-detail').textContent = detail;
    $('boot-pct').textContent = `${Math.floor(pct)}%`;
  };
  const tick = setInterval(() => {
    if (done || !el) return clearInterval(tick);
    $('boot-time').textContent = `${Math.floor((performance.now() - startedAt) / 1000)} s`;
    // The game creates its canvas when main() starts and draws the Mojang screen on its first frame.
    const frames = globalThis.__eaglerWatchdog?.renderFrameCount || globalThis.__eaglerFrameTiming?.samples?.length || 0;
    if (!failed && step === 'start' && frames > 0) screen.finish();
    // A crash after main() started is reported by client.js's error handlers into __eaglerStartup.
    const startup = globalThis.__eaglerStartup;
    if (!failed && step === 'start' && startup?.state === 'failed') screen.fail(startup.error);
  }, 250);

  // Counts the bytes of the game's downloads (Wasm, asset archive) as they stream in.
  // The wrapper stays installed (other modules may wrap fetch after it) but passes everything
  // through untouched once startup is over.
  const realFetch = globalThis.fetch;
  let tracking = true;
  const tracked = url => /\.wasm(\?|$)|assets\.(bin|idx)(\?|$)/.test(url);
  globalThis.fetch = async function (input, init) {
    if (!tracking) return realFetch.call(this, input, init);
    const url = String(input?.url ?? input);
    const response = await realFetch.call(this, input, init);
    if (!tracked(url) || !response.body) return response;
    const name = url.replace(/[?#].*$/, '').replace(/^.*\//, '');
    if (!response.ok) {
      screen.httpError = `${name}: HTTP ${response.status}${response.status === 404 ? ' (not found on this server)' : response.status === 403 ? ' (access denied — is the site locked for you?)' : ''}`;
      return response;
    }
    // Content-Length is the compressed size when the server compresses; only trust it otherwise.
    const encoded = response.headers.get('content-encoding');
    const total = !encoded || encoded === 'identity' ? Number(response.headers.get('content-length')) || 0 : 0;
    const entry = {loaded: 0, total};
    downloads.set(name, entry);
    const counter = new TransformStream({
      transform(chunk, controller) {
        entry.loaded += chunk.byteLength;
        const startup = globalThis.__eaglerStartup;
        if (startup) startup.lastProgressAt = performance.now();
        screen.progress();
        controller.enqueue(chunk);
      },
      flush() {
        entry.done = true;
      }
    });
    // The body is already decoded: drop the transfer headers that describe the encoded form.
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(response.body.pipeThrough(counter), {status: response.status, statusText: response.statusText, headers});
  };

  const screen = {
    httpError: null,
    set(nextStep, nextLabel, nextFraction = 0, nextDetail = '') {
      step = nextStep; label = nextLabel; fraction = nextFraction; detail = nextDetail;
      render();
    },
    // Called on every downloaded chunk: updates the bar of the current download step.
    progress() {
      const match = step === 'wasm' ? n => n.endsWith('.wasm') : step === 'assets' ? n => n.startsWith('assets.') : null;
      if (!match) return;
      let loaded = 0, total = 0, known = true;
      for (const [name, d] of downloads) if (match(name)) { loaded += d.loaded; total += d.total; if (!d.total) known = false; }
      if (known && total > 0) {
        fraction = loaded / total;
        detail = `${mb(loaded)} / ${mb(total)} MB`;
      } else {
        // Unknown size (compressed transfer): use the packaged size (an estimate for ?artifact= builds)
        // and never claim the step is complete before the last byte.
        const size = globalThis.__eaglerConfig?.client?.sizes?.[step];
        const expected = size || (step === 'wasm' ? 100 : 20) * 1048576;
        fraction = Math.min(0.97, loaded / expected);
        detail = size ? `${mb(loaded)} / ${mb(size)} MB` : `${mb(loaded)} MB downloaded`;
      }
      render();
    },
    fail(error) {
      failed = true;
      if (!el) return;
      el.classList.add('boot-failed');
      $('boot-status').textContent = 'The client failed to start';
      $('boot-detail').textContent = '';
      $('boot-error').textContent = [screen.httpError, String(error?.message || error)].filter(Boolean).join('\n');
      $('boot-error').hidden = false;
      $('boot-help').hidden = false;
    },
    finish() {
      if (done) return;
      done = true;
      tracking = false;
      clearInterval(tick);
      if (el) { el.classList.add('boot-hidden'); setTimeout(() => el.remove(), 400); }
    },
    // True once every download whose name ends with `suffix` has received its last byte.
    downloadsDone(suffix) {
      const list = [...downloads].filter(([name]) => name.endsWith(suffix));
      return list.length > 0 && list.every(([, d]) => d.done);
    },
    // Downloads have finished once main() runs; later fetches (sounds) go straight to the network.
    stopTracking() {
      tracking = false;
    }
  };
  render();
  return screen;
}
