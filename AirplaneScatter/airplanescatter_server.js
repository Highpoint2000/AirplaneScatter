////////////////////////////////////////////////////////////////
//                                                            //
//  AIRPLANE SCATTER SERVER PLUGIN FOR FM-DX-WEBSERVER (V2.2) //
//                                                            //
//  by Highpoint                last update: 2026-04-06       //
//                                                            //
//  https://github.com/Highpoint2000/AirplaneScatter          //
//                                                            //
////////////////////////////////////////////////////////////////

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
    version:      '2.2',
    frontEndPath: 'airplanescatter.js',
};
module.exports = { pluginConfig };

// ── Allowed proxy target domains ───────────────────────────────────────────
const PROXY_ALLOWED_DOMAINS = new Set([
    'api.adsb.one',
    'api.adsb.lol',
    'api.adsb.fi',
    'api.opentopodata.org',
    'api.open-elevation.com',
    'api.fmlist.org',
    'fmscan.org',
]);

// ── Per-domain response size caps ──────────────────────────────────────────
const RESPONSE_SIZE_LIMITS = {
    'default': 10 * 1024 * 1024,   // 10 MB – all proxy targets
};

function getResponseSizeLimit(hostname) {
    return RESPONSE_SIZE_LIMITS[hostname] ?? RESPONSE_SIZE_LIMITS['default'];
}

// ── FMDX server-side cache configuration ──────────────────────────────────
const FMDX_CACHE_TTL_MS     = 24 * 60 * 60 * 1000;  // 24 hours
const FMDX_GPS_RETRIGGER_KM = 100;                   // re-fetch if QTH moved > 100 km
const FMDX_CACHE_DIR        = path.join(__dirname, 'cache');
const FMDX_CACHE_FILE       = path.join(FMDX_CACHE_DIR, 'fmdx_full.json');
const FMDX_CACHE_META_FILE  = path.join(FMDX_CACHE_DIR, 'fmdx_meta.json');
const FMDX_UPSTREAM_URL     = 'https://maps.fmdx.org/api/';
const FMDX_UPSTREAM_TIMEOUT = 60000;

// In-memory state for the FMDX cache
let _fmdxRawData    = null;
let _fmdxFetchedAt  = 0;
let _fmdxFetchedLat = null;
let _fmdxFetchedLon = null;
let _fmdxFetching   = false;
let _fmdxFetchQueue = [];

// ── tx_search.js patching ──────────────────────────────────────────────────
// tx_search.js loads the same 50 MB FMDX database into RAM but does not
// export it. We patch its module exports at runtime so we can read localDb
// directly from memory – avoiding a redundant download entirely.
// The patch is non-destructive: it only ADDS getLocalDb() to the exports
// and does not touch any existing functionality.
let _txSearchPatched = false;

function patchTxSearch() {
    if (_txSearchPatched) return;
    try {
        const txSearchPath = require.resolve('../../server/tx_search');
        const txSearch     = require(txSearchPath);

        // Already patched by a previous run (e.g. server hot-reload)
        if (typeof txSearch.getLocalDb === 'function') {
            logInfo('tx_search.js already exposes getLocalDb() – skipping patch.');
            _txSearchPatched = true;
            return;
        }

        // Access Node's internal module cache to get the live module object
        const mod = require.cache[txSearchPath];
        if (!mod) {
            logWarn('tx_search.js not found in module cache – patch skipped.');
            return;
        }

        // The module keeps localDb as a plain let variable in its closure.
        // We inject a getter by appending to module.exports so that
        // the reference always reflects the current value of localDb,
        // even after tx_search.js rebuilds the database.
        //
        // Strategy: wrap the original buildTxDatabase indirectly by reading
        // localDb through the module's own internal scope via a Proxy on exports.
        //
        // Since direct closure access is not possible in Node without vm hacks,
        // we instead patch the module file on disk (one-time, idempotent) and
        // trigger a graceful reload hint via log – OR use the simpler approach:
        // write a tiny accessor shim directly into module.exports at runtime.
        //
        // We use the safest approach: patch module.exports in-place so that
        // getLocalDb() reads the variable from the module's own require cache
        // by re-requiring it and calling the original fetchTx as a side-channel.
        // The cleanest safe method is a one-time file patch (idempotent).

        patchTxSearchFile(txSearchPath);

    } catch (e) {
        logWarn(`Could not patch tx_search.js: ${e.message}`);
    }
}

// ── One-time idempotent file patch ─────────────────────────────────────────
// Adds getLocalDb to the module.exports of tx_search.js on disk.
// The patch is wrapped in a sentinel comment so it is never applied twice.
// A server restart is required for the patch to take effect – we detect
// this and log a clear message.
const TX_SEARCH_PATCH_SENTINEL = '// [AirplaneScatter] getLocalDb patch applied';

function patchTxSearchFile(txSearchPath) {
    try {
        const src = fs.readFileSync(txSearchPath, 'utf8');

        // Already patched on disk
        if (src.includes(TX_SEARCH_PATCH_SENTINEL)) {
            logInfo('tx_search.js already patched on disk.');
            _txSearchPatched = true;
            return;
        }

        // Build the patch – appends getLocalDb() to the existing exports block
        const exportLine   = 'module.exports = {';
        const patchedExport = `${TX_SEARCH_PATCH_SENTINEL}\nmodule.exports = {`;
        const getterLine   = `    getLocalDb: () => localDb,`;

        if (!src.includes(exportLine)) {
            logWarn('tx_search.js: could not find module.exports block – patch aborted.');
            return;
        }

        // Insert sentinel before module.exports and add getter as first property
        let patched = src.replace(
            exportLine,
            `${patchedExport}\n${getterLine}`
        );

        // Write back
        fs.writeFileSync(txSearchPath, patched, 'utf8');
        logInfo('tx_search.js patched successfully – getLocalDb() added to exports.');
        logInfo('NOTE: The patch takes effect after the next server restart.');
        _txSearchPatched = true;

    } catch (e) {
        logWarn(`Could not write patch to tx_search.js: ${e.message}`);
    }
}

// ── Read localDb from tx_search.js RAM (if patch is active) ───────────────
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

// ── FMDX cache validity check ──────────────────────────────────────────────
// Returns true when the cached data is still usable for the given QTH.
// Rules:
//   1. Data must have been fetched within the last 24 h.
//   2. If a previous fetch location is known, the current QTH must be
//      within FMDX_GPS_RETRIGGER_KM of it (handles GPS / mobile use).
function isFmdxCacheValid(lat, lon) {
    if (!_fmdxRawData)                                     return false;
    if (Date.now() - _fmdxFetchedAt > FMDX_CACHE_TTL_MS)  return false;
    if (_fmdxFetchedLat !== null && _fmdxFetchedLon !== null) {
        if (haversineKm(lat, lon, _fmdxFetchedLat, _fmdxFetchedLon) > FMDX_GPS_RETRIGGER_KM) {
            debugLog(`FMDX cache invalid: QTH moved > ${FMDX_GPS_RETRIGGER_KM} km.`);
            return false;
        }
    }
    return true;
}

// ── Persist cache metadata to disk ────────────────────────────────────────
function saveFmdxMeta() {
    try {
        ensureDir(FMDX_CACHE_DIR);
        fs.writeFileSync(FMDX_CACHE_META_FILE, JSON.stringify({
            fetchedAt:  _fmdxFetchedAt,
            fetchedLat: _fmdxFetchedLat,
            fetchedLon: _fmdxFetchedLon,
        }), 'utf8');
    } catch (e) {
        logWarn(`Could not save FMDX cache metadata: ${e.message}`);
    }
}

// ── Restore cache from disk on startup ────────────────────────────────────
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

// ── Fetch full FMDX DB from upstream ──────────────────────────────────────
function fetchFmdxUpstream(lat, lon) {
    return new Promise((resolve, reject) => {
        const upstreamUrl = `${FMDX_UPSTREAM_URL}?qth=${encodeURIComponent(lat + ',' + lon)}`;
        debugLog(`Fetching FMDX upstream: ${upstreamUrl}`);

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

// ── Wait for tx_search.js to finish loading its DB ────────────────────────
// Returns the core DB as soon as it's available, or null after timeout.
function waitForCoreDb(timeoutMs = 90000, intervalMs = 2000) {
    return new Promise((resolve) => {
        // Already available right now
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
                resolve(null); // null = caller must fetch itself
            }
        }, intervalMs);
    });
}

// ── Ensure FMDX data is available ─────────────────────────────────────────
// Priority order:
//   1. tx_search.js RAM (no download at all – best case for stationary QTH)
//   2. Plugin own RAM cache (valid within 24 h and QTH within 100 km)
//   3. Plugin disk cache (survives server restart)
//   4. Fresh upstream fetch (last resort)
function ensureFmdxData(lat, lon) {
    return new Promise((resolve, reject) => {

        // ── Priority 1: reuse core RAM database ───────────────────────────
        // If tx_search.js is still loading, wait up to 90s for it.
        waitForCoreDb().then(coreDb => {
            if (coreDb) {
                if (!_fmdxRawData) {
                    _fmdxRawData    = coreDb;
                    _fmdxFetchedAt  = Date.now();
                    _fmdxFetchedLat = lat;
                    _fmdxFetchedLon = lon;
                    logInfo('FMDX data taken from tx_search.js RAM – no download needed.');
                }
                return resolve(coreDb);
            }

            // ── Priority 2: own RAM cache ─────────────────���────────────────
            if (isFmdxCacheValid(lat, lon)) {
                debugLog('FMDX own RAM cache HIT.');
                return resolve(_fmdxRawData);
            }

            // ── Priority 3 & 4: fetch from upstream ───────────────────────
            if (_fmdxFetching) {
                debugLog('FMDX fetch in progress – queuing caller.');
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

                    ensureDir(FMDX_CACHE_DIR);
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
                        logWarn('Serving stale cache after upstream failure.');
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

// ── Server-side filter ─────────────────────────────────────────────────────
function filterStations(rawDb, lat, lon, radiusKm, minErpKw) {
    const locs     = rawDb.locations || rawDb;
    const latDelta = radiusKm / 111.0;
    const lonDelta = radiusKm / Math.max(0.1, Math.abs(111.0 * Math.cos(lat * Math.PI / 180)));
    const stations = [];

    for (const locId of Object.keys(locs)) {
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
// GET /api/airplanescatter/fmdx?qth=LAT,LON&radius=KM&erp=KW
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
            _end('Invalid or missing qth parameter (expected "lat,lon")');
            return;
        }

        const rawDb        = await ensureFmdxData(lat, lon);
        const stations     = filterStations(rawDb, lat, lon, radiusKm, minErpKw);
        const responseJson = JSON.stringify(stations);

        logInfo(`FMDX /fmdx: ${stations.length} stations (${(responseJson.length / 1024).toFixed(1)} KB) for QTH ${lat.toFixed(3)},${lon.toFixed(3)}.`);

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

// ── Files to sync from plugin dir → all public dirs ───────────────────────
const FILES_TO_SYNC = ['blacklist.txt', 'whitelist.txt', 'userlist1.csv'];

const PUBLIC_DIRS = [
    path.join(__dirname, '..', '..', 'public', 'plugins', 'AirplaneScatter'),
    path.join(__dirname, '..', '..', 'web',    'plugins', 'AirplaneScatter'),
];

// ── sealResponse ───────────────────────────────────────────────────────────
function sealResponse(res) {
    res.setHeader = () => {};
    res.writeHead = () => {};
    res.write     = () => {};
    res.end       = () => {};
}

// ── Ensure a directory exists ──────────────────────────────────────────────
function ensureDir(dir) {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
        logError(`Failed to create directory ${dir}: ${err.message}`);
    }
}

// ── Sync a single file to all public directories ──────────────────────────
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
                debugLog(`Created empty placeholder: ${destPath}`);
            }
        } catch (err) {
            logError(`Failed to sync ${fileName} to ${destDir}: ${err.message}`);
        }
    });
    logInfo(`Synced ${fileName} to all public dirs.`);
}

function syncAllFilesToPublic() {
    FILES_TO_SYNC.forEach(fileName => syncFileToPublic(fileName));
}

// ── Per-file watchers ──────────────────────────────────────────────────────
const _fileWatchers   = {};
const _debounceTimers = {};

function setupFileWatcher(fileName) {
    const srcPath = path.join(__dirname, fileName);
    if (_fileWatchers[fileName]) {
        try { _fileWatchers[fileName].close(); } catch (_) {}
        delete _fileWatchers[fileName];
    }
    if (!fs.existsSync(srcPath)) {
        debugLog(`Skipping watcher for missing file: ${fileName}`);
        return;
    }
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
        logInfo(`Watching ${fileName} for changes.`);
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

    debugLog(`Proxying: ${targetUrlStr}`);

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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer':    'https://fmscan.org/',
            'Cookie':     'cookieConsent=true; FMSCAN=ba5f492c037ed4faadd6c6235f57797a; FMLISTFMSCAN=1kihEisqpMz6mkNaJLlw02OWiN6xZGIQqryvQgb5tQ2W0FwAQXwHQBdyPZmogv5N%7Cjens.burkert%40gmx.de%7C28788318343'
        },
        timeout: 10000
    };

    const proxyReq = client.request(options, (proxyRes) => {
        if (responded) { proxyRes.resume(); return; }
        responded = true;
        debugLog(`Upstream responded ${proxyRes.statusCode} for ${targetUrl.hostname}`);
        try { _setHeader('Access-Control-Allow-Origin', '*'); } catch (_) {}
        if (proxyRes.headers['content-type']) {
            try { _setHeader('Content-Type', proxyRes.headers['content-type']); } catch (_) {}
        }
        try { _writeHead(proxyRes.statusCode); } catch (_) {}

        proxyRes.on('data', chunk => {
            bytesReceived += chunk.length;
            if (bytesReceived > MAX_RESPONSE_BYTES) {
                logWarn(`Response too large from ${targetUrl.hostname} – aborting.`);
                proxyReq.destroy();
                try { _end(); } catch (_) {}
                return;
            }
            try { _write(chunk); } catch (_) {}
        });
        proxyRes.on('end',   ()  => { try { _end();  } catch (_) {} });
        proxyRes.on('error', e   => {
            logError(`Upstream pipe error (${targetUrl.hostname}): ${e.message}`);
            try { _end(); } catch (_) {}
        });
    });

    proxyReq.on('timeout', () => {
        logError(`Timeout: ${targetUrl.hostname}`);
        sendError(504, 'Gateway Timeout');
        proxyReq.destroy();
    });
    proxyReq.on('error', (e) => {
        if (responded) return;
        logError(`Proxy error (${targetUrl.hostname}): ${e.message}`);
        sendError(502, `Proxy error: ${e.message}`);
    });
    proxyReq.end();
}

// ── Initialisation ─────────────────────────────────────────────────────────
function init() {

    // 1. Patch tx_search.js to export getLocalDb() (idempotent, one-time)
    logInfo('Patching tx_search.js to expose getLocalDb()...');
    patchTxSearch();

    // 2. Restore own FMDX disk cache (fallback if tx_search.js not yet loaded)
    logInfo('Restoring FMDX cache from disk...');
    restoreFmdxCacheFromDisk();

    // 3. Sync config files to all public directories
    logInfo('Syncing config files to all public dirs...');
    syncAllFilesToPublic();

    // 4. Watch config files for changes
    setupAllFileWatchers();

    // 5. Attach request handlers
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
            } else if (req.url.startsWith('/api/airplanescatter/proxy')) {
                handleRequest(req, res);
            }
        });

        logInfo('Endpoints /fmdx and /proxy successfully attached to HTTP server.');
    } catch (e) {
        logError(`Could not register API routes: ${e.message}`);
    }
}

setTimeout(init, 500);