// GoldProxy automatic reconnection policy (java:// servers only; Eagler connections never consult it).
//
// Decides, for one ended GoldProxy session, whether Gold Client reconnects by itself, after how long, and why
// not otherwise. Pure logic with an injectable clock, so Node tests drive it directly; Java
// (GoldProxyReconnect) owns the countdown screen and the actual reconnect.
//
// Ending kinds reported by Java:
//   'kick'      the server sent a Minecraft disconnect packet (text = its message)
//   'transport' the stream ended without one (backend EOF/reset, WebSocket lost); code = gateway code if any
//   'gateway'   a reconnect attempt failed before Minecraft started (code = gateway error code)
//   'user'      the player left (Disconnect, Quit, switching servers); never reconnected
//
// An episode is the run of automatic reconnects for one destination. It starts on the first reconnect after a
// healthy session and ends when the player cancels, starts a new join themselves, a session stays healthy in
// PLAY for `healthyMs`, or `maxAttempts` reconnects did not get there.

export const DEFAULT_RECONNECT = Object.freeze({
  enabled: true,
  delayMs: 3000,
  maxAttempts: 3,
  // Time in PLAY before a session counts as healthy and the attempt counter resets. A kick one second after
  // PLAY therefore keeps counting, which bounds kick/rejoin loops.
  healthyMs: 60000,
  // Server messages that explicitly ask the player to reconnect. Each rule needs a host match AND every phrase
  // (case-sensitive substrings of the plain-text kick): narrow on purpose, so arbitrary kicks never qualify.
  verificationRules: [
    {
      id: 'radiant-verified',
      hosts: ['mc.radiantnet.club', 'radiantnet.club'],
      all: ['You have successfully passed the verification', 'You are now able to play on the server when you reconnect'],
    },
  ],
});

// Gateway codes after which another attempt can succeed (destination briefly down, overload, network trouble).
// Anything else (authorization, allowlist, blocked address/port, protocol errors, unknown) is final.
const RETRYABLE_GATEWAY = new Set(['CONNECT_FAILED', 'CONNECT_TIMEOUT', 'DNS_FAILED', 'OVERLOADED', 'RATE_LIMITED', 'OPEN_TIMEOUT', 'INTERNAL', 'NETWORK']);

function hostMatches(host, patterns) {
  const h = String(host || '').toLowerCase();
  return (patterns || []).some((p) => {
    const q = String(p).toLowerCase();
    return q.startsWith('*.') ? h.endsWith(q.slice(1)) : h === q;
  });
}

/** Normalizes a (possibly partial) deploy-config policy over the defaults. */
export function reconnectPolicy(config = {}) {
  const c = config || {};
  const num = (v, d, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : d);
  return {
    enabled: c.enabled !== false,
    delayMs: num(c.delayMs, DEFAULT_RECONNECT.delayMs, 0, 60000),
    maxAttempts: num(c.maxAttempts, DEFAULT_RECONNECT.maxAttempts, 0, 10),
    healthyMs: num(c.healthyMs, DEFAULT_RECONNECT.healthyMs, 1000, 3600000),
    verificationRules: Array.isArray(c.verificationRules) ? c.verificationRules : DEFAULT_RECONNECT.verificationRules,
  };
}

/** Which verification rule (if any) this kick satisfies. */
export function matchVerification(policy, host, text) {
  const t = String(text || '');
  for (const rule of policy.verificationRules) {
    if (!rule || !Array.isArray(rule.all) || rule.all.length === 0) continue;
    if (!hostMatches(host, rule.hosts)) continue;
    if (rule.all.every((phrase) => typeof phrase === 'string' && phrase.length > 0 && t.includes(phrase))) return rule.id || 'rule';
  }
  return null;
}

/**
 * @param {() => object} getPolicy  current policy (re-read per decision, so deploy config changes apply)
 * @param {() => number} now
 */
export function createReconnectTracker(getPolicy = () => reconnectPolicy(), now = () => Date.now()) {
  /** target -> {attempts, playAt, decided: Map(sessionId -> decision)} */
  const episodes = new Map();
  const episode = (target) => {
    let e = episodes.get(target);
    if (!e) episodes.set(target, (e = { attempts: 0, playAt: 0, decided: new Map() }));
    return e;
  };

  function classify(policy, e, { host, kind, text, code }) {
    if (!policy.enabled) return { ok: false, cause: 'disabled' };
    if (kind === 'user') return { ok: false, cause: 'user' };
    if (kind === 'kick') {
      const rule = matchVerification(policy, host, text);
      return rule ? { ok: true, cause: 'verification', rule } : { ok: false, cause: 'server-kick' };
    }
    if (kind === 'transport') {
      // A gateway that refused or failed the session for a policy reason is final even mid-stream.
      if (code && !RETRYABLE_GATEWAY.has(code)) return { ok: false, cause: 'gateway:' + code };
      return { ok: true, cause: 'transport' };
    }
    if (kind === 'gateway') {
      // Only inside an episode: a join the player started that cannot reach the server just shows the error.
      if (e.attempts === 0) return { ok: false, cause: 'gateway:' + (code || 'unknown') };
      return code && RETRYABLE_GATEWAY.has(code) ? { ok: true, cause: 'gateway:' + code } : { ok: false, cause: 'gateway:' + (code || 'unknown') };
    }
    return { ok: false, cause: 'unknown-kind' };
  }

  return {
    /**
     * One ended session -> {reconnect, delayMs, attempt, maxAttempts, cause, rule, duplicate}.
     * The same sessionId always gets the same answer (no second timer for one ending).
     */
    decide({ target, host, kind, text = '', code = null, sessionId }) {
      const policy = getPolicy();
      const e = episode(target);
      if (sessionId != null && e.decided.has(sessionId)) return { ...e.decided.get(sessionId), duplicate: true };
      if (e.playAt && now() - e.playAt >= policy.healthyMs) e.attempts = 0; // a healthy session closes the episode
      e.playAt = 0;
      const c = classify(policy, e, { host, kind, text, code });
      let d;
      if (!c.ok) d = { reconnect: false, cause: c.cause };
      else if (e.attempts >= policy.maxAttempts) d = { reconnect: false, cause: 'limit', lastCause: c.cause };
      else {
        e.attempts++;
        d = { reconnect: true, delayMs: policy.delayMs, cause: c.cause, rule: c.rule || null };
      }
      d.attempt = e.attempts;
      d.maxAttempts = policy.maxAttempts;
      // A refusal ends the episode: the next ending starts counting from zero (after the player rejoins).
      if (!d.reconnect) { e.attempts = 0; e.decided.clear(); }
      if (sessionId != null) {
        e.decided.set(sessionId, d);
        if (e.decided.size > 16) e.decided.delete(e.decided.keys().next().value);
      }
      return d;
    },
    /** The session for `target` reached PLAY (the healthy-session clock starts here). */
    play(target) { episode(target).playAt = now(); },
    /** The player cancelled the countdown or started a join themselves: no episode carries over. */
    reset(target) { episodes.delete(target); },
    state(target) {
      const e = episodes.get(target);
      return e ? { attempts: e.attempts, playAt: e.playAt } : { attempts: 0, playAt: 0 };
    },
  };
}
