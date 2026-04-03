////////////////////////////////////////////////////////////////
//                                                            //
//  AIRPLANE SCATTER SERVER PLUGIN FOR FM-DX-WEBSERVER (V2.0) //
//                                                            //
//  by Highpoint                last update: 2026-04-03       //
//                                                            //
//  https://github.com/Highpoint2000/AirplaneScatter          //
//                                                            //
////////////////////////////////////////////////////////////////

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ── Debug logging toggle ───────────────────────────────────────────────────
const DEBUG_LOG = false;

// ── FM-DX-Webserver logging ──���─────────────────────────────────────────────
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
    version:      '2.0',
    frontEndPath: 'airplanescatter.js',
};
module.exports = { pluginConfig };

// ── Allowed proxy target domains ───────────────────────────────────────────
// Only domains actually requested via proxyUrl() in the client script.
// Removed: api.airplanes.live, adsbexchange.com  – not used by the client.
//          tef.noobish.eu  – fetched directly (not via proxyUrl).
//          flagcdn.com     – used as direct <img src>, never proxied.
const PROXY_ALLOWED_DOMAINS = new Set([
    'api.adsb.one',
    'api.adsb.lol',
    'api.adsb.fi',
    'api.opentopodata.org',
    'api.open-elevation.com',
    'maps.fmdx.org',
    'api.fmlist.org',
]);

// ── Per-domain response size caps ──────────────────────────────────────────
// maps.fmdx.org delivers the full FM transmitter database which can exceed
// 10 MB. All other upstream APIs return small JSON payloads (<< 1 MB).
const RESPONSE_SIZE_LIMITS = {
    'maps.fmdx.org': 50 * 1024 * 1024,   // 50 MB  – TX database
    'default':       10 * 1024 * 1024,   // 10 MB  – everything else
};

function getResponseSizeLimit(hostname) {
    return RESPONSE_SIZE_LIMITS[hostname] ?? RESPONSE_SIZE_LIMITS['default'];
}

// ── Files to sync from plugin dir → all public dirs ───────────────────────
const FILES_TO_SYNC = ['blacklist.txt', 'whitelist.txt'];

// ── All target directories the frontend may read from ─────────────────────
// The FM-DX-Webserver serves static files from both 'public' and 'web'.
// We sync to both so the file is reachable regardless of server version.
const PUBLIC_DIRS = [
    path.join(__dirname, '..', '..', 'public', 'plugins', 'AirplaneScatter'),
    path.join(__dirname, '..', '..', 'web',    'plugins', 'AirplaneScatter'),
];

// ── sealResponse ───────────────────────────────────────────────────────────
// Express runs AFTER our prependListener and tries to call res.setHeader()
// on the already-finished response, which crashes Node with ERR_HTTP_HEADERS_SENT.
// We overwrite the response methods with no-ops so Express becomes harmless.
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
                // Source missing – create empty placeholder so fetch() doesn't 404
                fs.writeFileSync(destPath, '');
                debugLog(`Created empty placeholder: ${destPath}`);
            }
        } catch (err) {
            logError(`Failed to sync ${fileName} to ${destDir}: ${err.message}`);
        }
    });

    logInfo(`Synced ${fileName} to all public dirs.`);
}

// ── Sync all tracked files ─────────────────────────────────────────────────
function syncAllFilesToPublic() {
    FILES_TO_SYNC.forEach(fileName => syncFileToPublic(fileName));
}

// ── Per-file watchers ──────────────────────────────────────────────────────
const _fileWatchers   = {};
const _debounceTimers = {};

function setupFileWatcher(fileName) {
    const srcPath = path.join(__dirname, fileName);

    // Close any existing watcher for this file
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

            // Debounce rapid successive save events (e.g. editor auto-save)
            if (_debounceTimers[fileName]) clearTimeout(_debounceTimers[fileName]);
            _debounceTimers[fileName] = setTimeout(() => {
                logInfo(`Change detected in ${fileName} – syncing to all public dirs...`);

                // Tear down watcher temporarily to avoid Windows re-trigger loop
                if (_fileWatchers[fileName]) {
                    try { _fileWatchers[fileName].close(); } catch (_) {}
                    delete _fileWatchers[fileName];
                }

                syncFileToPublic(fileName);

                // Re-establish watcher after file system has settled
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

// ── Request handler ────────────────────────────────────────────────────────
function handleRequest(req, res) {

    // ── 1. Caller guard ────────────────────────────────────────────────────
    // Only allow requests that originate from the server itself (localhost)
    // or from a browser that loaded the page from this same server
    // (identified via the Origin / Referer header matching the server host).
    // This prevents external actors from using this proxy as a relay.
    const rawIp    = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                  || req.socket?.remoteAddress
                  || '';
    const clientIp = rawIp.replace(/^::ffff:/, ''); // normalise IPv4-mapped IPv6

    const LOCAL_IPS = new Set(['127.0.0.1', '::1', '0.0.0.0', 'localhost']);
    const isLocal   = LOCAL_IPS.has(clientIp);

    if (!isLocal) {
        const serverHost = req.headers['host'] || '';
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

    // ── 2. OPTIONS preflight ───────────────────────────────────────────────
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.writeHead(200);
        res.end();
        sealResponse(res);
        return;
    }

    // ── 3. Method check ────────────────────────────────────────────────────
    if (req.method !== 'GET') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        sealResponse(res);
        return;
    }

    // ── 4. Parse incoming request URL ───────────────────���─────────────────
    let reqUrl;
    try {
        reqUrl = new URL(req.url, `http://${req.headers.host}`);
    } catch (e) {
        res.writeHead(400);
        res.end('Bad request URL');
        sealResponse(res);
        return;
    }

    const targetUrlStr = reqUrl.searchParams.get('url');
    if (!targetUrlStr) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing url parameter');
        sealResponse(res);
        return;
    }

    let targetUrl;
    try {
        targetUrl = new URL(targetUrlStr);
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid URL format');
        sealResponse(res);
        return;
    }

    // ── 5. Protocol check ──────────────────────────────────────────────────
    // Reject anything that is not http or https (e.g. file://, data:, ftp://).
    if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Only http/https target URLs are allowed');
        sealResponse(res);
        return;
    }

    // ── 6. Domain whitelist check ──────────────────────────────────────────
    if (!PROXY_ALLOWED_DOMAINS.has(targetUrl.hostname)) {
        logWarn(`Proxy blocked request to: ${targetUrl.hostname}`);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: Target domain not allowed');
        sealResponse(res);
        return;
    }

    debugLog(`Proxying: ${targetUrlStr}`);

    // Save the real response methods before sealing
    const _setHeader = res.setHeader.bind(res);
    const _writeHead = res.writeHead.bind(res);
    const _write     = res.write.bind(res);
    const _end       = res.end.bind(res);

    // Seal immediately – Express can no longer interfere while we await the upstream
    sealResponse(res);

    let responded     = false;
    let bytesReceived = 0;
    const MAX_RESPONSE_BYTES = getResponseSizeLimit(targetUrl.hostname); // domain-specific cap

    function sendError(code, msg) {
        if (responded) return;
        responded = true;
        try { _writeHead(code, { 'Content-Type': 'text/plain' }); } catch (_) {}
        try { _end(msg); } catch (_) {}
    }

    const client = targetUrl.protocol === 'https:' ? https : http;

    const options = {
        hostname: targetUrl.hostname,
        port:     targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path:     targetUrl.pathname + targetUrl.search,
        method:   'GET',
        headers: {
            'User-Agent': 'FM-DX-Webserver AirplaneScatter Proxy (Node.js)',
            'Accept':     'application/json, text/plain, */*'
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
            // ── 7. Response size cap ───────────────────────────────────────
            bytesReceived += chunk.length;
            if (bytesReceived > MAX_RESPONSE_BYTES) {
                logWarn(`Response too large from ${targetUrl.hostname} (>${(MAX_RESPONSE_BYTES / 1024 / 1024).toFixed(0)} MB) – aborting.`);
                proxyReq.destroy();
                try { _end(); } catch (_) {}
                return;
            }
            try { _write(chunk); } catch (_) {}
        });

        proxyRes.on('end',   ()  => { try { _end();  } catch (_) {} });
        proxyRes.on('error', e  => {
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

    // 1. Initial sync of all config files to every public directory
    logInfo('Syncing config files to all public dirs...');
    syncAllFilesToPublic();

    // 2. Watch source files and re-sync automatically on every change
    setupAllFileWatchers();

    // 3. Attach proxy handler to the HTTP server
    try {
        if (!pluginsApi) {
            logWarn('pluginsApi not found. Proxy cannot be started.');
            return;
        }

        const server = pluginsApi.getHttpServer();
        if (!server) {
            logWarn('pluginsApi.getHttpServer() returned null.');
            return;
        }

        // prependListener ensures we run BEFORE Express processes the request
        server.prependListener('request', (req, res) => {
            if (!req.url) return;
            if (req.url.startsWith('/api/airplanescatter/proxy')) {
                handleRequest(req, res);
            }
        });

        logInfo('Proxy endpoint successfully attached to HTTP server.');
    } catch (e) {
        logError(`Could not register API routes: ${e.message}`);
    }
}

// Delay startup to ensure the FM-DX-Webserver HTTP server is fully up
setTimeout(init, 500);