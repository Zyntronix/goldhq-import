export async function preloadVanillaAssets(manifestUrl = './vanilla-assets/manifest.json') {
  const base = new URL(manifestUrl, document.baseURI);
  const responses = await Promise.all(['assets.idx', 'assets.bin'].map(async name => {
    const url = new URL(name, base);
    url.search = base.search;
    const response = await fetch(url, {cache: 'no-store'});
    if (!response.ok) throw new Error(`Browser asset archive missing (${response.status}): ${url}`);
    return name.endsWith('.idx') ? response.json() : response.arrayBuffer();
  }));
  const [index, buffer] = responses;
  const names = Object.keys(index.manifest.assets);
  const map = Object.create(null);
  globalThis.__eaglerAssetProgress?.(0, names.length);
  for (const path of names) {
    const range = index.ranges[path];
    if (!Array.isArray(range) || range.length !== 2 ||
        !range.every(Number.isSafeInteger) || range[0] < 0 || range[1] < 0 ||
        range[0] > buffer.byteLength - range[1]) {
      throw new Error(`Invalid browser asset archive range: ${path}`);
    }
    // Keep Java's synchronous asset() bridge while deferring view creation until use.
    let bytes;
    Object.defineProperty(map, path, {
      enumerable: true,
      configurable: true,
      get() {
        return bytes || (bytes = new Uint8Array(buffer, range[0], range[1]));
      }
    });
  }
  globalThis.__eaglerVanillaAssets = map;
  globalThis.__eaglerVanillaAssetNames = names;
  globalThis.__eaglerAssetProgress?.(names.length, names.length);
  return index.manifest;
}

// Sound archive: the index is loaded at boot so Minecraft's resource listing
// sees every OGG, while bytes are fetched on first play by the audio backend.
// Range requests keep only requested sounds in memory; a server that ignores
// Range gets one whole-archive fetch that later reads slice from.
//
// excluded: {category: [path, ...]} lists sounds an offline build left out on
// purpose (the player turned music, music discs or sound effects off when
// downloading it). They stay listed, so vanilla's sound registry is unchanged
// and logs no missing files, and read() rejects them with error.excluded set to
// the category so the audio backend stays quiet instead of reporting them.
export function createSoundArchive(binUrl, ranges, fetchImpl = fetch, excluded = null) {
  let whole = null;
  let probe = null;
  const left = new Map();
  if (excluded) for (const [category, paths] of Object.entries(excluded)) for (const p of paths) left.set(p, category);
  const archive = {
    mode: 'unknown',
    excludedCount: left.size,
    has: path => Object.prototype.hasOwnProperty.call(ranges, path) || left.has(path),
    excludedCategory: path => left.get(path) || null,
    readSync(path) {
      const range = ranges[path];
      return whole && range ? new Uint8Array(whole, range[0], range[1]) : null;
    },
    async read(path) {
      const range = ranges[path];
      if (!range && left.has(path)) {
        const error = new Error(`${path} is not included in this offline build (${left.get(path)} turned off)`);
        error.excluded = left.get(path);
        throw error;
      }
      if (!range) throw new Error(`missing archive entry ${path}`);
      const slice = () => whole.slice(range[0], range[0] + range[1]);
      if (whole) return slice();
      if (archive.mode === 'unknown' && probe) {
        await probe.catch(() => {});
        return archive.read(path);
      }
      const request = (async () => {
        const response = await fetchImpl(binUrl, archive.mode === 'whole' ? {} : {headers: {Range: `bytes=${range[0]}-${range[0] + range[1] - 1}`}});
        if (response.status === 206) {
          const data = await response.arrayBuffer();
          if (data.byteLength !== range[1]) throw new Error(`short range for ${path}: ${data.byteLength}/${range[1]}`);
          archive.mode = 'range';
          return data;
        }
        if (!response.ok) throw new Error(`sound archive HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        if (!whole) whole = data;
        archive.mode = 'whole';
        return slice();
      })();
      if (archive.mode === 'unknown') probe = request;
      return request;
    }
  };
  return archive;
}

export async function preloadSoundArchive(indexUrl = '../../build/browser-assets/sounds.idx') {
  const url = new URL(indexUrl, document.baseURI);
  let index;
  try {
    const response = await fetch(url, {cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    index = await response.json();
  } catch (error) {
    console.log(`[AUDIO] sound archive index unavailable (${url}): ${error.message || error}; sounds will be missing`);
    return null;
  }
  const binUrl = new URL(index.bin || 'sounds.bin', url);
  binUrl.search = url.search;
  const excluded = index.excluded && typeof index.excluded === 'object' ? index.excluded : null;
  const names = Object.keys(index.ranges);
  if (excluded) for (const paths of Object.values(excluded)) if (Array.isArray(paths)) names.push(...paths);
  const archive = globalThis.__eaglerSoundArchive = createSoundArchive(binUrl, index.ranges, fetch, excluded);
  const vanillaNames = globalThis.__eaglerVanillaAssetNames;
  const existing = new Set(vanillaNames);
  for (const name of names) if (!existing.has(name)) vanillaNames.push(name);
  const left = excluded ? Object.entries(excluded).map(([c, p]) => `${c} ${p.length}`).join(', ') : '';
  console.log(`[AUDIO] sound archive indexed: ${names.length - archive.excludedCount} files, ${index.bytes ?? '?'} bytes` +
    (left ? `; left out of this offline build: ${left}` : ''));
  return archive;
}
