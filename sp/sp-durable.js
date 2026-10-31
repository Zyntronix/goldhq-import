// Eagler26 singleplayer, Stage 2: durable world storage for the integrated-server worker. Classic script; defines
// globalThis.EaglerSpDurable.
//
// The in-memory store (sp-storage.js) is the synchronous working set the server reads and writes. This layer makes a
// world durable in IndexedDB database 'eagler26-sp-worlds' (separate from the client's own 'eagler26' database):
//
//   files   key [worldId, relPath] -> {worldId, path, data: ArrayBuffer, size, modified, generation}
//   worlds  key worldId            -> {worldId, levelName, createdAt, lastSavedAt, generation, files, bytes,
//                                      sizes: {relPath: bytes}, gameVersion, dataVersion}
//
// commit(worldId) writes every journaled change of that world (sp-storage.js takeDirty) AND the world record in ONE
// readwrite transaction opened with durability 'strict'. The transaction either commits as a whole or not at all:
// an interrupted save (worker terminated, tab closed, quota error, I/O error) leaves the previous generation intact,
// and the journal entries of a failed commit are put back so the next save retries them. A save is reported as saved
// only after the transaction's complete event. World ids are namespaced (sp-world-*), every key starts with the world
// id, and a world is opened under a navigator.locks lock so two tabs cannot write one world.
//
// Why IndexedDB and not OPFS: a save must commit many files (level.dat, region/entities/poi .mca, data/*.dat)
// atomically. IndexedDB transactions give that directly and work in every engine, in the offline file:// blob worker
// (Stage 0: OPFS is unavailable there) and in Firefox. OPFS offers per-file sync handles but no multi-file atomic
// commit; it remains an option for a later, larger-world backend behind the same commit() contract.
(function () {
  'use strict';
  const DB_NAME = 'eagler26-sp-worlds';
  const DB_VERSION = 1;
  const SKIP = /(^|\/)session\.lock$/; // vanilla's per-process lock file; the worker uses navigator.locks instead

  const promise = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  async function open(options = {}) {
    if (!globalThis.indexedDB) throw new Error('IndexedDB is unavailable in this browser context: worlds cannot be saved');
    const name = options.dbName || DB_NAME;
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', {keyPath: ['worldId', 'path']});
      if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', {keyPath: 'worldId'});
    };
    const db = await promise(request);
    db.onversionchange = () => db.close();
    const faults = options.faults || {};
    const stats = {commits: 0, failedCommits: 0, filesWritten: 0, filesDeleted: 0, bytesWritten: 0, loads: 0, bytesLoaded: 0, lastCommit: null, lastError: null};
    const range = worldId => IDBKeyRange.bound([worldId, ''], [worldId, '￿']);
    const locks = new Map();

    const api = {
      dbName: name,
      stats,

      async listWorlds() {
        const tx = db.transaction('worlds', 'readonly');
        const worlds = await promise(tx.objectStore('worlds').getAll());
        return worlds.sort((a, b) => (b.lastSavedAt || 0) - (a.lastSavedAt || 0));
      },

      async getWorld(worldId) {
        return (await promise(db.transaction('worlds', 'readonly').objectStore('worlds').get(worldId))) || null;
      },

      /** Copies a committed world into the in-memory store under root (not journaled). */
      async loadWorld(worldId, store, root) {
        const started = performance.now();
        const tx = db.transaction(['files', 'worlds'], 'readonly');
        const [record, rows] = await Promise.all([promise(tx.objectStore('worlds').get(worldId)), promise(tx.objectStore('files').getAll(range(worldId)))]);
        if (!record) return null;
        const bytes = store.hydrate(rows.map(r => ({path: root + '/' + r.path, bytes: r.data, modified: r.modified})));
        stats.loads++;
        stats.bytesLoaded += bytes;
        return {files: rows.length, bytes, generation: record.generation, ms: Math.round(performance.now() - started)};
      },

      /**
       * Commits the journal of one world. Resolves after the transaction is durable; rejects (journal restored) on any
       * failure. meta: {levelName, gameVersion, dataVersion} merged into the world record.
       */
      async commit(worldId, store, root, meta = {}) {
        const started = performance.now();
        const entries = store.takeDirty(root).filter(e => !SKIP.test(e.path));
        try {
          if (faults.failDurableCommit) throw new Error('simulated IndexedDB failure (fault injection)');
          if (faults.durableQuota) throw new DOMException('simulated quota exhaustion (fault injection)', 'QuotaExceededError');
          const tx = db.transaction(['files', 'worlds'], 'readwrite', {durability: 'strict'});
          const done = txDone(tx);
          const filesStore = tx.objectStore('files');
          const worldsStore = tx.objectStore('worlds');
          const previous = await promise(worldsStore.get(worldId));
          const generation = (previous ? previous.generation : 0) + 1;
          let written = 0, deleted = 0, bytes = 0;
          const sizes = {...(previous && previous.sizes || {})};
          for (const e of entries) {
            const rel = e.path.slice(root.length + 1);
            if (e.bytes === null) {
              filesStore.delete([worldId, rel]);
              delete sizes[rel];
              deleted++;
            } else {
              // A fresh, exactly-sized ArrayBuffer (the store's buffer may be a view into a larger one).
              const data = e.bytes.byteOffset === 0 && e.bytes.byteLength === e.bytes.buffer.byteLength ? e.bytes.buffer : e.bytes.slice().buffer;
              filesStore.put({worldId, path: rel, data, size: e.bytes.byteLength, modified: e.modified, generation});
              sizes[rel] = e.bytes.byteLength;
              written++;
              bytes += e.bytes.byteLength;
            }
          }
          const now = Date.now();
          const record = {...(previous || {createdAt: now}), ...meta, worldId, generation, lastSavedAt: now, sizes};
          record.files = Object.keys(sizes).length;
          record.bytes = Object.values(sizes).reduce((a, b) => a + b, 0);
          worldsStore.put(record);
          await done;
          const result = {worldId, generation, files: written, deleted, bytes, totalFiles: record.files, ms: Math.round(performance.now() - started)};
          stats.commits++; stats.filesWritten += written; stats.filesDeleted += deleted; stats.bytesWritten += bytes;
          stats.lastCommit = {...result, at: now};
          return result;
        } catch (error) {
          store.restoreDirty(entries);
          stats.failedCommits++;
          const name = error && error.name || 'Error';
          stats.lastError = {name, message: String(error && error.message || error), at: Date.now()};
          const wrapped = new Error((name === 'QuotaExceededError' ? 'browser storage quota exceeded: ' : 'durable save failed: ') + (error && error.message || error));
          wrapped.code = name === 'QuotaExceededError' ? 'STORAGE_QUOTA' : 'DURABLE_SAVE_FAILED';
          wrapped.pendingChanges = entries.length;
          throw wrapped;
        }
      },

      async deleteWorld(worldId) {
        const tx = db.transaction(['files', 'worlds'], 'readwrite', {durability: 'strict'});
        const done = txDone(tx);
        tx.objectStore('files').delete(range(worldId));
        tx.objectStore('worlds').delete(worldId);
        await done;
        return true;
      },

      /** Exclusive per-world lock across tabs and workers (navigator.locks); null when another holder has it. */
      async lockWorld(worldId) {
        if (locks.has(worldId)) return locks.get(worldId);
        if (!globalThis.navigator || !navigator.locks) return {worldId, release() {}, unsupported: true};
        const handle = await new Promise(resolve => {
          navigator.locks.request('eagler26-sp-world:' + worldId, {ifAvailable: true}, lock => {
            if (!lock) { resolve(null); return undefined; }
            return new Promise(release => resolve({worldId, release: () => { locks.delete(worldId); release(); }}));
          }).catch(() => resolve(null));
        });
        if (handle) locks.set(worldId, handle);
        return handle;
      },

      async estimate() {
        try { return globalThis.navigator && navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
      },

      async persisted() {
        try { return globalThis.navigator && navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch { return null; }
      },

      close() { db.close(); }
    };
    return api;
  }

  globalThis.EaglerSpDurable = {open, DB_NAME};
})();
