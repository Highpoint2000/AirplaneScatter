/////////////////////////////////////////////////////////////////
//                                                             //
//  AIRPLANE SCATTER SERVER PLUGIN FOR FM-DX-WEBSERVER (V2.4b) //
//                                                             //
//  by Highpoint                last update: 2026-05-19        //
//                                                             //
//  https://github.com/Highpoint2000/AirplaneScatter           //
//                                                             //
/////////////////////////////////////////////////////////////////

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');

// ── Debug logging toggle ───────────────────────────────────────────────────
const DEBUG_LOG = false;

// ── FM-DX-Webserver logging ───────────────────────────────────────────────
let logInfo, logWarn, logError;
try {
    const con = require('./../../server/console');
    logInfo  = (msg) => con.logInfo ('AirplaneScatter', msg);
    logWarn  = (msg) => con.logWarn ('AirplaneScatter', msg);
    logError = (msg) => con.logError('AirplaneScatter', msg);
} catch (e) {
    logInfo  = (msg) => console.log (`[INFO]  [Airplane Scatter] ${msg}`);
    logWarn  = (msg) => console.warn(`[WARN]  [Airplane Scatter] ${msg}`);
    logError = (msg) => console.error(`[ERROR] [Airplane Scatter] ${msg}`);
}

function debugLog(msg) {
    if (DEBUG_LOG) logInfo(msg);
}

// ── plugins_api ────────────────────────────────────────────────────────────
let pluginsApi;
try {
    pluginsApi = require('../../server/plugins_api');
} catch (e) {
    logWarn(`Could not load plugins_api: ${e.message}`);
}

// ── Plugin registration ────────────────────────────────────────────────────
const pluginConfig = {
    name:         'Airplane Scatter',
    version:      '2.4',
    frontEndPath: 'airplanescatter.js',
};
module.exports = { pluginConfig };

// ── Allowed proxy target domains ───────────────────────────────────────────
const PROXY_ALLOWED_DOMAINS = new Set([
    'api.adsb.one',
    'api.adsb.lol',
    'api.adsb.fi',
    'api.airplanes.live',       // <-- NEU
    'api.theairtraffic.com',    // <-- NEU
    'api.opentopodata.org',
    'api.open-elevation.com',
    'api.fmlist.org',
    'fmscan.org',
]);

// ── Per-domain response size caps ──────────────────────────────────────────
const RESPONSE_SIZE_LIMITS = {
    'default': 10 * 1024 * 1024,   // 10 MB
};

function getResponseSizeLimit(hostname) {
    return RESPONSE_SIZE_LIMITS[hostname] ?? RESPONSE_SIZE_LIMITS['default'];
}

// ── Server-side cache configuration ───────────────────────────────────────
const CACHE_DIR             = path.join(__dirname, 'cache');
const FMDX_CACHE_TTL_MS     = 24 * 60 * 60 * 1000;
const FMDX_GPS_RETRIGGER_KM = 100;
const FMDX_CACHE_FILE       = path.join(CACHE_DIR, 'fmdx_full.json');
const FMDX_CACHE_META_FILE  = path.join(CACHE_DIR, 'fmdx_meta.json');
const ELEV_CACHE_FILE       = path.join(CACHE_DIR, 'elevation_cache.json');
const FMDX_UPSTREAM_URL     = 'https://maps.fmdx.org/api/';
const FMDX_UPSTREAM_TIMEOUT = 60000;

// In-memory state for the FMDX cache
let _fmdxRawData    = null;
let _fmdxFetchedAt  = 0;
let _fmdxFetchedLat = null;
let _fmdxFetchedLon = null;
let _fmdxFetching   = false;
let _fmdxFetchQueue = [];

// In-memory state for Elevation cache
let _elevCache      = {};
let _elevCacheDirty = false;

// ── tx_search.js patching ──────────────────────────────────────────────────
let _txSearchPatched = false;

function patchTxSearch() {
    if (_txSearchPatched) return;
    try {
        const txSearchPath = require.resolve('../../server/tx_search');
        const txSearch     = require(txSearchPath);

        if (typeof txSearch.getLocalDb === 'function') {
            logInfo('tx_search.js already exposes getLocalDb() – skipping patch.');
            _txSearchPatched = true;
            return;
        }

        const mod = require.cache[txSearchPath];
        if (!mod) {
            logWarn('tx_search.js not found in module cache – patch skipped.');
            return;
        }

        patchTxSearchFile(txSearchPath);
    } catch (e) {
        logWarn(`Could not patch tx_search.js: ${e.message}`);
    }
}

const TX_SEARCH_PATCH_SENTINEL = '// [AirplaneScatter] getLocalDb patch applied';

function patchTxSearchFile(txSearchPath) {
    try {
        const src = fs.readFileSync(txSearchPath, 'utf8');
        if (src.includes(TX_SEARCH_PATCH_SENTINEL)) {
            logInfo('tx_search.js already patched on disk.');
            _txSearchPatched = true;
            return;
        }
        const exportLine   = 'module.exports = {';
        const patchedExport = `${TX_SEARCH_PATCH_SENTINEL}\nmodule.exports = {`;
        const getterLine   = `    getLocalDb: () => localDb,`;

        if (!src.includes(exportLine)) {
            logWarn('tx_search.js: could not find module.exports block – patch aborted.');
            return;
        }

        let patched = src.replace(exportLine, `${patchedExport}\n${getterLine}`);
        fs.writeFileSync(txSearchPath, patched, 'utf8');
        logInfo('tx_search.js patched successfully – getLocalDb() added to exports.');
        logInfo('NOTE: The patch takes effect after the next server restart.');
        _txSearchPatched = true;
    } catch (e) {
        logWarn(`Could not write patch to tx_search.js: ${e.message}`);
    }
}

function getCoreDb() {
    try {
        const txSearch = require('../../server/tx_search');
        if (typeof txSearch.getLocalDb === 'function') {
            const db = txSearch.getLocalDb();
            if (db && Object.keys(db).length > 0) {
                debugLog('Using core TX database from tx_search.js RAM.');
                return db;
            }
        }
    } catch (e) {
        debugLog(`getCoreDb failed: ${e.message}`);
    }
    return null;
}

// ── Geo helper (Haversine) ─────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
    const R     = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat  = toRad(lat2 - lat1);
    const dLon  = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Elevation Cache Management ─────────────────────────────────────────────
function loadElevCache() {
    try {
        ensureDir(CACHE_DIR);
        if (fs.existsSync(ELEV_CACHE_FILE)) {
            _elevCache = JSON.parse(fs.readFileSync(ELEV_CACHE_FILE, 'utf8'));
            logInfo(`Loaded ${Object.keys(_elevCache).length} elevation points from disk cache.`);
        }
    } catch (e) {
        logWarn(`Could not load elevation cache: ${e.message}`);
        _elevCache = {};
    }
}

function saveElevCache() {
    if (!_elevCacheDirty) return;
    try {
        ensureDir(CACHE_DIR);
        fs.writeFileSync(ELEV_CACHE_FILE, JSON.stringify(_elevCache));
        _elevCacheDirty = false;
        debugLog('Saved elevation cache to disk.');
    } catch (e) {
        logWarn(`Could not save elevation cache: ${e.message}`);
    }
}
// Periodically save the elevation cache to disk (every 15 seconds) if dirty
setInterval(saveElevCache, 15000);

// ── FMDX cache management ──────────────────────────────────────────────────
function isFmdxCacheValid(lat, lon) {
    if (!_fmdxRawData) return false;
    if (Date.now() - _fmdxFetchedAt > FMDX_CACHE_TTL_MS) return false;
    if (_fmdxFetchedLat !== null && _fmdxFetchedLon !== null) {
        if (haversineKm(lat, lon, _fmdxFetchedLat, _fmdxFetchedLon) > FMDX_GPS_RETRIGGER_KM) {
            debugLog(`FMDX cache invalid: QTH moved > ${FMDX_GPS_RETRIGGER_KM} km.`);
            return false;
        }
    }
    return true;
}

function saveFmdxMeta() {
    try {
        ensureDir(CACHE_DIR);
        fs.writeFileSync(FMDX_CACHE_META_FILE, JSON.stringify({
            fetchedAt:  _fmdxFetchedAt,
            fetchedLat: _fmdxFetchedLat,
            fetchedLon: _fmdxFetchedLon,
        }), 'utf8');
    } catch (e) {
        logWarn(`Could not save FMDX cache metadata: ${e.message}`);
    }
}

function restoreFmdxCacheFromDisk() {
    try {
        if (!fs.existsSync(FMDX_CACHE_FILE) || !fs.existsSync(FMDX_CACHE_META_FILE)) return;
        const meta = JSON.parse(fs.readFileSync(FMDX_CACHE_META_FILE, 'utf8'));
        if (!meta.fetchedAt) return;
        if (Date.now() - meta.fetchedAt > FMDX_CACHE_TTL_MS) {
            debugLog('FMDX disk cache expired – will re-fetch on first request.');
            return;
        }
        const raw = fs.readFileSync(FMDX_CACHE_FILE, 'utf8');
        _fmdxRawData    = JSON.parse(raw);
        _fmdxFetchedAt  = meta.fetchedAt;
        _fmdxFetchedLat = meta.fetchedLat ?? null;
        _fmdxFetchedLon = meta.fetchedLon ?? null;
        logInfo(`FMDX disk cache restored (fetched ${new Date(_fmdxFetchedAt).toISOString()}).`);
    } catch (e) {
        logWarn(`Could not restore FMDX disk cache: ${e.message}`);
    }
}

function fetchFmdxUpstream(lat, lon) {
    return new Promise((resolve, reject) => {
        const upstreamUrl = `${FMDX_UPSTREAM_URL}?qth=${encodeURIComponent(lat + ',' + lon)}`;
        const req = https.get(upstreamUrl, {
            headers: {
                'User-Agent': 'FM-DX-Webserver AirplaneScatter Plugin (Node.js)',
                'Accept':     'application/json',
            },
            timeout: FMDX_UPSTREAM_TIMEOUT,
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Upstream HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data',  chunk => chunks.push(chunk));
            res.on('end',   ()    => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        });

        req.on('timeout', () => { req.destroy(); reject(new Error('Upstream timeout')); });
        req.on('error',   reject);
    });
}

function waitForCoreDb(timeoutMs = 90000, intervalMs = 2000) {
    return new Promise((resolve) => {
        const db = getCoreDb();
        if (db) return resolve(db);

        const start   = Date.now();
        const timer   = setInterval(() => {
            const db = getCoreDb();
            if (db) {
                clearInterval(timer);
                logInfo('tx_search.js DB became available – using core RAM.');
                return resolve(db);
            }
            if (Date.now() - start >= timeoutMs) {
                clearInterval(timer);
                logWarn(`tx_search.js DB not available after ${timeoutMs / 1000}s – falling back to own fetch.`);
                resolve(null);
            }
        }, intervalMs);
    });
}

function ensureFmdxData(lat, lon) {
    return new Promise((resolve, reject) => {
        waitForCoreDb().then(coreDb => {
            if (coreDb) {
                if (!_fmdxRawData) {
                    _fmdxRawData    = coreDb;
                    _fmdxFetchedAt  = Date.now();
                    _fmdxFetchedLat = lat;
                    _fmdxFetchedLon = lon;
                }
                return resolve(coreDb);
            }
            if (isFmdxCacheValid(lat, lon)) return resolve(_fmdxRawData);

            if (_fmdxFetching) {
                _fmdxFetchQueue.push({ resolve, reject });
                return;
            }

            _fmdxFetching = true;
            logInfo('FMDX cache miss – fetching from upstream...');

            fetchFmdxUpstream(lat, lon)
                .then(rawJson => {
                    const parsed    = JSON.parse(rawJson);
                    _fmdxRawData    = parsed;
                    _fmdxFetchedAt  = Date.now();
                    _fmdxFetchedLat = lat;
                    _fmdxFetchedLon = lon;

                    ensureDir(CACHE_DIR);
                    fs.writeFile(FMDX_CACHE_FILE, rawJson, 'utf8', err => {
                        if (err) logWarn(`Could not write FMDX cache: ${err.message}`);
                    });
                    saveFmdxMeta();
                    logInfo(`FMDX DB fetched (${(rawJson.length / 1024 / 1024).toFixed(1)} MB).`);

                    _fmdxFetching = false;
                    resolve(parsed);
                    _fmdxFetchQueue.forEach(cb => cb.resolve(parsed));
                    _fmdxFetchQueue = [];
                })
                .catch(err => {
                    _fmdxFetching = false;
                    logError(`FMDX upstream fetch failed: ${err.message}`);
                    if (_fmdxRawData) {
                        resolve(_fmdxRawData);
                        _fmdxFetchQueue.forEach(cb => cb.resolve(_fmdxRawData));
                    } else {
                        reject(err);
                        _fmdxFetchQueue.forEach(cb => cb.reject(err));
                    }
                    _fmdxFetchQueue = [];
                });
        });
    });
}

async function filterStationsAsync(rawDb, lat, lon, radiusKm, minErpKw) {
    const locs     = rawDb.locations || rawDb;
    const latDelta = radiusKm / 111.0;
    const lonDelta = radiusKm / Math.max(0.1, Math.abs(111.0 * Math.cos(lat * Math.PI / 180)));
    const stations = [];

    const keys = Object.keys(locs);
    let lastYield = performance.now();

    for (let i = 0; i < keys.length; i++) {
        if (performance.now() - lastYield > 5) {
            await new Promise(resolve => setImmediate(resolve));
            lastYield = performance.now();
        }

        const locId = keys[i];
        const loc    = locs[locId];
        if (!loc || !Array.isArray(loc.stations)) continue;
        const locLat = parseFloat(loc.lat);
        const locLon = parseFloat(loc.lon);

        if (Math.abs(locLat - lat) > latDelta || Math.abs(locLon - lon) > lonDelta) continue;

        const dist = haversineKm(lat, lon, locLat, locLon);
        if (dist > radiusKm) continue;

        for (const st of loc.stations) {
            const fMHz = parseFloat(st.freq);
            const erp  = parseFloat(st.erp);
            if (fMHz < 87.5 || fMHz > 108.0 || isNaN(erp) || erp < minErpKw) continue;
            stations.push({
                id:       st.id,
                freq:     fMHz,
                city:     loc.name    || '',
                itu:      loc.itu     || '',
                erp,
                lat:      locLat,
                lon:      locLon,
                dist:     Math.round(dist),
                terrainM: 0,
                station:  st.station  || '',
                ps:       st.ps       || '',
                pol:      st.pol      || '',
            });
        }
    }
    return stations;
}

// ── FMDX endpoint handler ──────────────────────────────────────────────────
async function handleFmdxRequest(req, res) {
    const _setHeader = res.setHeader.bind(res);
    const _writeHead = res.writeHead.bind(res);
    const _end       = res.end.bind(res);
    sealResponse(res);

    try {
        const reqUrl   = new URL(req.url, `http://${req.headers.host}`);
        const qth      = reqUrl.searchParams.get('qth') || '';
        const radiusKm = Math.min(1500, Math.max(50, parseFloat(reqUrl.searchParams.get('radius')) || 750));
        const minErpKw = Math.max(0,                  parseFloat(reqUrl.searchParams.get('erp'))    || 100);

        const [latStr, lonStr] = qth.split(',');
        const lat = parseFloat(latStr);
        const lon = parseFloat(lonStr);

        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            _writeHead(400, { 'Content-Type': 'text/plain' });
            _end('Invalid or missing qth parameter');
            return;
        }

        const rawDb        = await ensureFmdxData(lat, lon);
        const stations     = await filterStationsAsync(rawDb, lat, lon, radiusKm, minErpKw);
        const responseJson = JSON.stringify(stations);

        _setHeader('Access-Control-Allow-Origin', '*');
        _setHeader('Content-Type', 'application/json; charset=utf-8');
        _setHeader('Cache-Control', 'no-store');
        _writeHead(200);
        _end(responseJson);

    } catch (err) {
        logError(`FMDX endpoint error: ${err.message}`);
        try { _writeHead(502, { 'Content-Type': 'text/plain' }); } catch (_) {}
        try { _end(`Upstream error: ${err.message}`); } catch (_) {}
    }
}

// ── Elevation endpoint handler ─────────────────────────────────────────────
async function handleElevationRequest(req, res) {
    const _setHeader = res.setHeader.bind(res);
    const _writeHead = res.writeHead.bind(res);
    const _end       = res.end.bind(res);
    sealResponse(res);

    try {
        const reqUrl = new URL(req.url, `http://${req.headers.host}`);
        const locsParam = reqUrl.searchParams.get('locations');
        if (!locsParam) {
            _writeHead(400); _end('Missing locations parameter'); return;
        }

        const locPairs = locsParam.split('|');
        const missing = [];
        const results = new Array(locPairs.length);

        for (let i = 0; i < locPairs.length; i++) {
            const loc = locPairs[i];
            if (_elevCache[loc] !== undefined) {
                results[i] = { elevation: _elevCache[loc] };
            } else {
                missing.push({ index: i, loc });
            }
        }

        if (missing.length > 0) {
            // Helper for https GET
            const fetchHttps = (url) => new Promise((resolve, reject) => {
                https.get(url, { headers: { 'User-Agent': 'AirplaneScatter Plugin' } }, (r) => {
                    let data = '';
                    r.on('data', d => data += d);
                    r.on('end', () => resolve({ status: r.statusCode, data }));
                }).on('error', reject);
            });

            // Fetch missing chunks from upstream APIs
            for (let i = 0; i < missing.length; i += 100) {
                const chunk = missing.slice(i, i + 100);
                const chunkLocs = chunk.map(m => m.loc).join('|');
                let success = false;

                // 1. Try primary API (OpenTopoData)
                try {
                    const url1 = `https://api.opentopodata.org/v1/srtm90m?locations=${encodeURIComponent(chunkLocs)}`;
                    const respData = await fetchHttps(url1);
                    if (respData.status === 200) {
                        const parsed = JSON.parse(respData.data);
                        if (parsed && parsed.results) {
                            parsed.results.forEach((r, idx) => {
                                const elev = Math.max(0, r.elevation || 0);
                                const origLoc = chunk[idx].loc;
                                const origIdx = chunk[idx].index;
                                _elevCache[origLoc] = elev;
                                _elevCacheDirty = true;
                                results[origIdx] = { elevation: elev };
                            });
                            success = true;
                        }
                    }
                } catch (err) {
                    logWarn(`OpenTopoData fetch error: ${err.message}`);
                }

                // 2. Fallback to Open-Elevation if primary fails (e.g. Rate Limit reached)
                if (!success) {
                    try {
                        const url2 = `https://api.open-elevation.com/api/v1/lookup?locations=${encodeURIComponent(chunkLocs)}`;
                        const respData = await fetchHttps(url2);
                        if (respData.status === 200) {
                            const parsed = JSON.parse(respData.data);
                            if (parsed && parsed.results) {
                                parsed.results.forEach((r, idx) => {
                                    const elev = Math.max(0, r.elevation || 0);
                                    const origLoc = chunk[idx].loc;
                                    const origIdx = chunk[idx].index;
                                    _elevCache[origLoc] = elev;
                                    _elevCacheDirty = true;
                                    results[origIdx] = { elevation: elev };
                                });
                                success = true;
                            }
                        }
                    } catch (err) {
                        logWarn(`Open-Elevation fetch error: ${err.message}`);
                    }
                }

                // 3. If both APIs fail, abort and return 502 Error! (prevents caching of 0s)
                if (!success) {
                    _writeHead(502); 
                    _end('Upstream APIs overloaded'); 
                    return;
                }

                // Respect 1 req/sec limit for OpenTopoData if there are more chunks waiting
                if (i + 100 < missing.length) {
                    await new Promise(r => setTimeout(r, 1100));
                }
            }
        }

        _setHeader('Access-Control-Allow-Origin', '*');
        _setHeader('Content-Type', 'application/json; charset=utf-8');
        _writeHead(200);
        _end(JSON.stringify({ results }));

    } catch (err) {
        logError(`Elevation endpoint error: ${err.message}`);
        try { _writeHead(500); _end('Server Error'); } catch (_) {}
    }
}

// ── File syncing and watching ──────────────────────────────────────────────
const FILES_TO_SYNC = ['blacklist.txt', 'whitelist.txt', 'userlist1.csv'];

const PUBLIC_DIRS = [
    path.join(__dirname, '..', '..', 'public', 'plugins', 'AirplaneScatter'),
    path.join(__dirname, '..', '..', 'web',    'plugins', 'AirplaneScatter'),
];

function sealResponse(res) {
    res.setHeader = () => {};
    res.writeHead = () => {};
    res.write     = () => {};
    res.end       = () => {};
}

function ensureDir(dir) {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
        logError(`Failed to create directory ${dir}: ${err.message}`);
    }
}

function syncFileToPublic(fileName) {
    const srcPath = path.join(__dirname, fileName);
    PUBLIC_DIRS.forEach(destDir => {
        ensureDir(destDir);
        const destPath = path.join(destDir, fileName);
        try {
            if (fs.existsSync(srcPath)) {
                fs.copyFileSync(srcPath, destPath);
                debugLog(`Synced ${fileName} → ${destDir}`);
            } else if (!fs.existsSync(destPath)) {
                fs.writeFileSync(destPath, '');
            }
        } catch (err) {
            logError(`Failed to sync ${fileName} to ${destDir}: ${err.message}`);
        }
    });
}

function syncAllFilesToPublic() {
    FILES_TO_SYNC.forEach(fileName => syncFileToPublic(fileName));
}

const _fileWatchers   = {};
const _debounceTimers = {};

function setupFileWatcher(fileName) {
    const srcPath = path.join(__dirname, fileName);
    if (_fileWatchers[fileName]) {
        try { _fileWatchers[fileName].close(); } catch (_) {}
        delete _fileWatchers[fileName];
    }
    if (!fs.existsSync(srcPath)) return;
    try {
        _fileWatchers[fileName] = fs.watch(srcPath, { persistent: false }, (eventType) => {
            if (eventType !== 'change') return;
            if (_debounceTimers[fileName]) clearTimeout(_debounceTimers[fileName]);
            _debounceTimers[fileName] = setTimeout(() => {
                logInfo(`Change detected in ${fileName} – syncing...`);
                if (_fileWatchers[fileName]) {
                    try { _fileWatchers[fileName].close(); } catch (_) {}
                    delete _fileWatchers[fileName];
                }
                syncFileToPublic(fileName);
                setTimeout(() => setupFileWatcher(fileName), 1000);
            }, 500);
        });
    } catch (err) {
        logError(`Could not set up watcher for ${fileName}: ${err.message}`);
    }
}

function setupAllFileWatchers() {
    FILES_TO_SYNC.forEach(fileName => setupFileWatcher(fileName));
}

// ── Generic proxy request handler ─────────────────────────────────────────
function handleRequest(req, res) {
    const rawIp    = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                  || req.socket?.remoteAddress || '';
    const clientIp = rawIp.replace(/^::ffff:/, '');
    const LOCAL_IPS = new Set(['127.0.0.1', '::1', '0.0.0.0', 'localhost']);
    const isLocal   = LOCAL_IPS.has(clientIp);

    if (!isLocal) {
        const serverHost = req.headers['host']    || '';
        const origin     = req.headers['origin']  || '';
        const referer    = req.headers['referer'] || '';
        const isSameOrigin = serverHost &&
            (origin.includes(serverHost) || referer.includes(serverHost));
        if (!isSameOrigin) {
            logWarn(`Proxy blocked: external IP=${clientIp}, origin="${origin}", referer="${referer}"`);
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            sealResponse(res);
            return;
        }
    }

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin',  '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.writeHead(200);
        res.end();
        sealResponse(res);
        return;
    }

    if (req.method !== 'GET') {
        res.writeHead(405); res.end('Method Not Allowed');
        sealResponse(res); return;
    }

    let reqUrl;
    try {
        reqUrl = new URL(req.url, `http://${req.headers.host}`);
    } catch (e) {
        res.writeHead(400); res.end('Bad request URL');
        sealResponse(res); return;
    }

    const targetUrlStr = reqUrl.searchParams.get('url');
    if (!targetUrlStr) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing url parameter');
        sealResponse(res); return;
    }

    let targetUrl;
    try {
        targetUrl = new URL(targetUrlStr);
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid URL format');
        sealResponse(res); return;
    }

    if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Only http/https target URLs are allowed');
        sealResponse(res); return;
    }

    if (!PROXY_ALLOWED_DOMAINS.has(targetUrl.hostname)) {
        logWarn(`Proxy blocked request to: ${targetUrl.hostname}`);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: Target domain not allowed');
        sealResponse(res); return;
    }

    const _setHeader = res.setHeader.bind(res);
    const _writeHead = res.writeHead.bind(res);
    const _write     = res.write.bind(res);
    const _end       = res.end.bind(res);
    sealResponse(res);

    let responded     = false;
    let bytesReceived = 0;
    const MAX_RESPONSE_BYTES = getResponseSizeLimit(targetUrl.hostname);

    function sendError(code, msg) {
        if (responded) return;
        responded = true;
        try { _writeHead(code, { 'Content-Type': 'text/plain' }); } catch (_) {}
        try { _end(msg); } catch (_) {}
    }

    const client  = targetUrl.protocol === 'https:' ? https : http;
    const options = {
        hostname: targetUrl.hostname,
        port:     targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path:     targetUrl.pathname + targetUrl.search,
        method:   'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer':    'https://fmscan.org/',
            'Cookie':     'cookieConsent=true; FMSCAN=ba5f492c037ed4faadd6c6235f57797a; FMLISTFMSCAN=1kihEisqpMz6mkNaJLlw02OWiN6xZGIQqryvQgb5tQ2W0FwAQXwHQBdyPZmogv5N%7Cjens.burkert%40gmx.de%7C28788318343'
        },
        timeout: 10000
    };

    const proxyReq = client.request(options, (proxyRes) => {
        if (responded) { proxyRes.resume(); return; }
        responded = true;
        try { _setHeader('Access-Control-Allow-Origin', '*'); } catch (_) {}
        if (proxyRes.headers['content-type']) {
            try { _setHeader('Content-Type', proxyRes.headers['content-type']); } catch (_) {}
        }
        try { _writeHead(proxyRes.statusCode); } catch (_) {}

        proxyRes.on('data', chunk => {
            bytesReceived += chunk.length;
            if (bytesReceived > MAX_RESPONSE_BYTES) {
                proxyReq.destroy();
                try { _end(); } catch (_) {}
                return;
            }
            try { _write(chunk); } catch (_) {}
        });
        proxyRes.on('end',   ()  => { try { _end();  } catch (_) {} });
        proxyRes.on('error', e   => { try { _end(); } catch (_) {} });
    });

    proxyReq.on('timeout', () => { sendError(504, 'Gateway Timeout'); proxyReq.destroy(); });
    proxyReq.on('error', (e) => { if (!responded) sendError(502, `Proxy error: ${e.message}`); });
    proxyReq.end();
}

// ── Initialisation ─────────────────────────────────────────────────────────
function init() {
    logInfo('Patching tx_search.js to expose getLocalDb()...');
    patchTxSearch();

    logInfo('Restoring FMDX and Elevation caches from disk...');
    restoreFmdxCacheFromDisk();
    loadElevCache();

    logInfo('Syncing config files to all public dirs...');
    syncAllFilesToPublic();
    setupAllFileWatchers();

    try {
        if (!pluginsApi) {
            logWarn('pluginsApi not found. Endpoints cannot be started.');
            return;
        }
        const server = pluginsApi.getHttpServer();
        if (!server) {
            logWarn('pluginsApi.getHttpServer() returned null.');
            return;
        }

        server.prependListener('request', (req, res) => {
            if (!req.url) return;
            if (req.url.startsWith('/api/airplanescatter/fmdx')) {
                handleFmdxRequest(req, res);
            } else if (req.url.startsWith('/api/airplanescatter/elevation')) {
                handleElevationRequest(req, res);
            } else if (req.url.startsWith('/api/airplanescatter/proxy')) {
                handleRequest(req, res);
            }
        });

        logInfo('Endpoints /fmdx, /elevation and /proxy successfully attached to HTTP server.');
    } catch (e) {
        logError(`Could not register API routes: ${e.message}`);
    }
}

setTimeout(init, 500);