///////////////////////////////////////////////////////////////
//                                                           //
//  AIRPLANE SCATTER PLUGIN FOR FM-DX-WEBSERVER (V1.1)       //
//                                                           //
//  by Highpoint                last update: 2026-04-02      //
//                                                           //
//  https://github.com/Highpoint2000/RDS-AI-Decoder          //
//                                                           //
///////////////////////////////////////////////////////////////

(() => {

    // ── Plugin metadata & Update Check ────────────────────────────────────
    const pluginVersion     = "1.1";
    const pluginName        = "Airplane Scatter";
    const pluginHomepageUrl = "https://github.com/highpoint2000/AirplaneScatter/releases";
    const pluginUpdateUrl   = "https://raw.githubusercontent.com/Highpoint2000/AirplaneScatter/refs/heads/main/AirplaneScatter/airplanescatter.js";
    const CHECK_FOR_UPDATES = true;

    function _checkUpdate() {
        fetch(pluginUpdateUrl + "?t=" + Date.now(), { cache: "no-store" })
            .then(r => r.ok ? r.text() : null)
            .then(txt => {
                if (!txt) return;
                const m = txt.match(/(?:const|let|var)\s+pluginVersion\s*=\s*["']([^"']+)["']/);
                if (!m) return;
                const remote = m[1];
                if (remote === pluginVersion) return;
                console.log(`[${pluginName}] Update available: ${pluginVersion} → ${remote}`);

                // Inject link into #plugin-settings
                const settings = document.getElementById("plugin-settings");
                if (settings && settings.innerHTML.indexOf(pluginHomepageUrl) === -1) {
                    settings.innerHTML += `<br><a href='${pluginHomepageUrl}' target='_blank'>[${pluginName}] Update: ${pluginVersion} → ${remote}</a>`;
                }

                // Inject red dot on the nav puzzle-piece icon
                const icon =
                    document.querySelector(".wrapper-outer #navigation .sidenav-content .fa-plane")?.closest('a') ||
                    document.querySelector(".wrapper-outer #navigation .sidenav-content .fa-puzzle-piece")?.closest('a') ||
                    document.querySelector(".wrapper-outer .sidenav-content") ||
                    document.querySelector(".sidenav-content");
                if (icon && !icon.querySelector(`.${pluginName}-update-dot`)) {
                    const dot = document.createElement("span");
                    dot.className = `${pluginName}-update-dot`;
                    dot.style.cssText =
                        "display:block;width:12px;height:12px;border-radius:50%;" +
                        "background-color:#FE0830;margin-left:82px;margin-top:-12px;";
                    icon.appendChild(dot);
                }
            })
            .catch(e => {
                console.warn(`[${pluginName}] Update check failed:`, e);
            });
    }
    if (CHECK_FOR_UPDATES) _checkUpdate();

    // ── Configuration ──────────────────────────────────────────────────────
    const corsAnywhereUrl        = 'https://cors-proxy.de:13128/';
    const FMDX_API_BASE          = 'https://maps.fmdx.org/api/';
    const ELEVATION_API          = corsAnywhereUrl + 'https://api.opentopodata.org/v1/srtm90m?locations='; 

    const FORECAST_STEPS_SEC     = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300];
    const AIRCRAFT_TIMEOUT_MS    = 180000; 

    const AIRCRAFT_UPDATE_MS     = 15000;
    const COUNTDOWN_TICK_MS      = 1000;
    const DB_CACHE_HOURS         = 24;
    const SCORE_EXCELLENT        = 80;
    const SCORE_HIGH             = 60;
    const SCORE_MEDIUM           = 40;

    const TX_HEIGHT_DEFAULT_M    = 150;
    const RX_AGL_DEFAULT_M       = 10;
    const AC_PREFILTER_KM        = 1200;
    const AC_PREFILTER_LATDEG    = 11.0;

    const AC_SIZE_MULT = {
        A1: 0.70, A2: 0.85, A3: 1.00, A4: 1.15, A5: 1.30, A6: 0.90, A7: 0.75,
        B1: 0.80, B2: 0.60, B3: 0.65, B4: 0.70, B6: 0.75,
        C1: 0.85, C2: 0.90, C3: 0.95
    };
    function acSizeMult(cat) {
        if (!cat) return 1.0;
        const c = cat.toUpperCase();
        return AC_SIZE_MULT[c] || (c[0] === 'A' ? 1.0 : 0.8);
    }

    // ── Logging ──────────────────────────────────────────────────────────
    function debugLog(...args) {
        console.log(`[${pluginName}]`, ...args);
    }

    // ── Time parsing helpers ──────────────────────────────────────────────
    function parseTimeStr(str, defSec) {
        if (!str) return defSec;
        const pts = str.split(':');
        if (pts.length === 2) {
            const m = parseInt(pts[0], 10);
            const s = parseInt(pts[1], 10);
            if (!isNaN(m) && !isNaN(s)) return m * 60 + s;
        }
        return defSec;
    }
    function formatTimeStr(sec) {
        const s = Math.max(0, Math.round(sec));
        const m = Math.floor(s / 60);
        const ss = s % 60;
        return m + ':' + (ss < 10 ? '0' : '') + ss;
    }

    // ── Settings ──────────────────────────────────────────────────────────
    function getInt(val, def) {
        if (val === null || val === undefined) return def;
        const parsed = parseInt(val, 10);
        return isNaN(parsed) ? def : parsed;
    }

    function loadSettings() {
        return {
            minTxRxDistKm   : getInt(localStorage.getItem('as_min_txrx_dist'), 400),
            minTxErpKw      : getInt(localStorage.getItem('as_min_erp'), 100),
            txRadiusKm      : getInt(localStorage.getItem('as_tx_radius'), 750),
            aircraftRadiusKm: getInt(localStorage.getItem('as_ac_radius'), 750),
            minScore        : getInt(localStorage.getItem('as_min_score'), 75),
            rxAglM          : getInt(localStorage.getItem('as_rx_agl'), 10),
            useMetric       : localStorage.getItem('as_use_metric') !== 'false',
            leadTimeSec     : parseTimeStr(localStorage.getItem('as_lead_time_str'), 180),
            trailTimeSec    : parseTimeStr(localStorage.getItem('as_trail_time_str'), 60)
        };
    }
    let S = loadSettings();
	

    let isAdminLoggedIn = false;
    let isTuneLoggedIn = false;
    let isLockAuthenticated = true;

    // Global helper function to send the Rotor position
    window._asSendRotorPosition = function(position) {
        if (!isAdminLoggedIn && !isTuneLoggedIn) {
            debugLog('Rotor turn rejected: Not authorized.');
            return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            const message = JSON.stringify({
                type: 'Rotor',
                value: position.toString(),
                lock: isLockAuthenticated,
                source: ipAddress,
                clientId: clientId
            });
            ws.send(message);
            debugLog(`Sent Rotor position: ${position}°`);
        } else {
            debugLog('WebSocket is not connected. Cannot send Rotor position.');
        }
    };

    // ── Formatting Helpers ────────────────────────────────────────────────
    function fmtAlt(ft) { return S.useMetric ? Math.round(ft * 0.3048) + ' m' : Math.round(ft) + ' ft'; }
    function fmtSpeed(kts) { return S.useMetric ? Math.round(kts * 1.852) + ' km/h' : Math.round(kts) + ' kts'; }
    function fmtVspeed(ftmin) {
        if(ftmin === null || ftmin === undefined) return '—';
        if(S.useMetric) return (ftmin > 0 ? '↑ ' : '↓ ') + Math.abs((ftmin * 0.00508).toFixed(1)) + ' m/s';
        return (ftmin > 0 ? '↑ ' : '↓ ') + Math.abs(Math.round(ftmin)) + ' ft/min';
    }
    
    function parseFreq(valStr) {
        let s = valStr.replace(',', '.').trim();
        if(!s) return null;
        let v = parseFloat(s);
        if(isNaN(v)) return null;
        if(v > 8700) v = v / 100;
        else if(v >= 870 && v <= 1080) v = v / 10;
        if(v >= 87.5 && v <= 108.0) return v;
        return null;
    }

    // ── Dynamic country → flag lookup via remote + cache ──────────────────
    const COUNTRY_LIST_URL       = 'https://tef.noobish.eu/logos/scripts/js/countryList.js';
    const COUNTRY_CACHE_KEY      = 'as_CountryList';
    const COUNTRY_CACHE_TIME_KEY = 'as_CountryListTime';
    const COUNTRY_CACHE_TTL      = 24 * 60 * 60 * 1000; // 24 hours

    let ituToFlag = null;
	const _flagHtmlCache = {};

    async function loadCountryLookup() {
        try {
            const raw = localStorage.getItem(COUNTRY_CACHE_KEY);
            const ts  = parseInt(localStorage.getItem(COUNTRY_CACHE_TIME_KEY) || '0', 10);
            if (raw && (Date.now() - ts < COUNTRY_CACHE_TTL)) {
                const parsed = JSON.parse(raw);
                if (Object.keys(parsed).length > 0) return parsed;
            }
        } catch (e) {}

        const res = await fetch(COUNTRY_LIST_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Country list fetch failed (${res.status})`);
        const jsText = await res.text();

        let countryList = [];
        try {
            countryList = (new Function(`${jsText}; return countryList;`))();
        } catch (e) {
            throw e;
        }

        const lookup = {};
        countryList.forEach(({ itu_code, country_code }) => {
            if (itu_code && country_code) {
                lookup[itu_code.toUpperCase()] = country_code.toLowerCase();
            }
        });

        try {
            localStorage.setItem(COUNTRY_CACHE_KEY, JSON.stringify(lookup));
            localStorage.setItem(COUNTRY_CACHE_TIME_KEY, Date.now().toString());
        } catch (e) {}

        return lookup;
    }

    function getFlagImg(itu, w=16, h=12) {
        if (!ituToFlag || !itu) return '';
        const key = itu.toUpperCase() + '_' + w + '_' + h;
        if (_flagHtmlCache[key] !== undefined) return _flagHtmlCache[key];
        const flagCode = ituToFlag[itu.toUpperCase()];
        if (!flagCode || flagCode === 'xx') { _flagHtmlCache[key] = ''; return ''; }
        const html = `<img src="https://flagcdn.com/24x18/${flagCode}.png" style="vertical-align:middle; width:${w}px; height:${h}px; border-radius:2px; box-shadow:0 0 2px rgba(0,0,0,0.5);" alt="${itu}">`;
        _flagHtmlCache[key] = html;
        return html;
    }
    // ── Elevation caches ──────────────────────────────────────────────────
    const ELEV_CACHE_KEY = 'as_elev_cache';
    let _elevCache = {};
    let _pathElevCache = {}; 
    let _currentPathElevs = null; 

    try {
        const stored = localStorage.getItem(ELEV_CACHE_KEY);
        if (stored) _elevCache = JSON.parse(stored);
    } catch(e) {}

    function saveElevCache() {
        try { localStorage.setItem(ELEV_CACHE_KEY, JSON.stringify(_elevCache)); } catch(e) {}
    }

    let _rxTerrainM  = 0;    
    let _rxElevM     = S.rxAglM; 
	
    async function fetchOpenElevation(lat, lon) {
        const key = lat.toFixed(4) + '_' + lon.toFixed(4);
        const url = corsAnywhereUrl + 'https://api.open-elevation.com/api/v1/lookup?locations=' + lat.toFixed(4) + ',' + lon.toFixed(4);
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            const height = j.results && j.results[0] && typeof j.results[0].elevation === 'number' ? Math.max(0, j.results[0].elevation) : 0;
            _elevCache[key] = height;
        } catch (e) {
            _elevCache[key] = 0; 
        }
    }

    async function fetchElevationBatch(points) {
        if (!points.length) return;
        const locs = points.map(p => p.lat.toFixed(4) + ',' + p.lon.toFixed(4)).join('|');
        let done = {};
        try {
            const r = await fetch(ELEVATION_API + locs);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            (j.results || []).forEach((res, idx) => {
                if (typeof res.elevation === 'number') {
                    _elevCache[points[idx].key] = Math.max(0, res.elevation || 0);
                    done[points[idx].key] = true;
                }
            });
        } catch (e) {}
        for (const p of points) {
            if (done[p.key] !== true && _elevCache[p.key] === undefined) {
                await fetchOpenElevation(p.lat, p.lon);
            }
        }
    }

    async function fetchElevationSingle(lat, lon) {
        const key = lat.toFixed(4) + '_' + lon.toFixed(4);
        if (_elevCache[key] !== undefined) return _elevCache[key];
        await fetchElevationBatch([{lat, lon, key}]);
        saveElevCache();
        return _elevCache[key] || 0;
    }

    async function enrichTxElevations(stations) {
        const unique = [], seen = new Set();
        stations.forEach(tx => {
            const k = tx.lat.toFixed(4) + '_' + tx.lon.toFixed(4);
            if (_elevCache[k] === undefined && !seen.has(k)) { 
                seen.add(k); unique.push({lat: tx.lat, lon: tx.lon, key: k}); 
            }
        });
        if (unique.length > 0) {
            for (let i = 0; i < unique.length; i += 100) await fetchElevationBatch(unique.slice(i, i + 100));
            saveElevCache(); 
        }
        stations.forEach(tx => {
            const k = tx.lat.toFixed(4) + '_' + tx.lon.toFixed(4);
            tx.terrainM = _elevCache[k] || 0;
        });
    }

    async function fetchPathElevation(rxLat, rxLon, txLat, txLon, txKey) {
        const cacheKey = rxLat.toFixed(2)+'_'+rxLon.toFixed(2)+'_'+txKey;
        if (_pathElevCache[cacheKey]) return _pathElevCache[cacheKey];

        const pts = generatePathPoints(rxLat, rxLon, txLat, txLon, 100);
        const locs = pts.map(p => p.lat.toFixed(4) + ',' + p.lon.toFixed(4)).join('|');
        try {
            const r = await fetch(ELEVATION_API + locs);
            if(!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            const elevs = (j.results || []).map(res => Math.max(0, res.elevation || 0));
            _pathElevCache[cacheKey] = elevs;
            return elevs;
        } catch(e) {
            return pts.map(() => 0); 
        }
    }

    // ── State ────────────────────────────────────────────────────────────
    let mapActive            = false;
    let mapContainer         = null;
    let mapInstance          = null;
    let leafletReady         = false;
    let leafletCbs           = [];
    let aircraftTimer        = null;
    let countdownTimer       = null;
    let txStations           = [];
    let txStationGrid        = {};
    let aircraftLayer        = null;
    let txLayer              = null;
    let lineLayer            = null;
    let rxMarker             = null;
    let _lastFetchTime       = 0;
    let _drMarkers           = {};
    let _txElements          = {}; 
    let ws                   = null;       // Data plugins WS
    let mainWebsocket        = null;       // Main Radio WS
    let rdsWebsocket         = null;       // Radio text WS for freq updates
    let gpsLat               = null;
    let gpsLon               = null;
    
    // Robust Tracking & Grouping
    let _activeAircraft      = {};
    let _persistentCrossings = {};

    let _activeTxKey         = null;   
    let _activeCompass       = null;
    let _activeFreq          = null; 
    let isFreqLocked         = false; // Track if filter is locked to radio
    let isCompassLocked      = false; // Track if compass filter is locked to rotor
    let lastRotorAzimuth     = null;  // Store last received rotor position

    // Generate unique client ID for PSTRotator compatibility
    const clientId = Math.random().toString(36).substring(2);

    // Profile State
    let _activeProfileTxKey  = null;
    let _activeProfileTxObj  = null;
    let _currentProfileDist  = 0;
    let profMinX = 0;
    let profMaxX = 0;
    let isDraggingProf = false;
    let lastMouseX = 0;
	let profScaleY = 1.0;

    const currentURL    = new URL(window.location.href);
    const WebserverURL  = currentURL.hostname;
    const WebserverPORT = currentURL.port || (currentURL.protocol === 'https:' ? '443' : '80');
    const WebserverPath = currentURL.pathname.replace(/setup/g, '');
    const protocol      = currentURL.protocol === 'https:' ? 'wss:' : 'ws:';
    const WEBSOCKET_URL = `${protocol}//${WebserverURL}:${WebserverPORT}${WebserverPath}data_plugins`;
    const TEXT_WS_URL   = `${protocol}//${WebserverURL}:${WebserverPORT}${WebserverPath}text`;

    // ── CSS ───────────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.innerHTML = `
        #as-wrapper{position:fixed;z-index:9000;display:flex;flex-direction:row;pointer-events:none;}
        #as-list-panel{pointer-events:all;width:250px;min-width:200px;background:#0d1420;border-right:1px solid #1e3050;display:flex;flex-direction:column;overflow:hidden;border-radius:12px 0 0 0;box-shadow:-2px 4px 24px rgba(0,0,0,0.7);flex-shrink:0;}
        #as-list-header{background:var(--color-2,#162032);color:#4aaeff;font-size:12px;font-weight:bold;padding:8px 10px 6px;border-bottom:1px solid #1e3050;flex-shrink:0; display:flex; justify-content:space-between; align-items:center;}
        #as-list-body{flex:1;overflow-y:auto;padding:4px 0;}
        #as-list-body::-webkit-scrollbar{width:4px;}
        #as-list-body::-webkit-scrollbar-thumb{background:#2a4a7a;border-radius:2px;}
        .as-list-item{padding:6px 10px;border-bottom:1px solid #1a2535;cursor:pointer;transition:background 0.15s;}
        .as-list-item:hover{background:#162032;}
        .as-list-item.as-list-active{background:#1a3560;border-left:3px solid #4aaeff;}
        .as-li-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;}
        .as-li-ac{font-size:12px;font-weight:bold;color:#fff;}
        .as-li-tx{font-size:11px;color:#cde;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .as-li-eta{font-size:13px;font-weight:bold;}
        .as-li-score{font-size:11px;font-weight:bold;}
        .as-list-approaching{opacity:0.6;}
        
        .as-sub-header {
            display: flex !important; flex-wrap: nowrap !important; align-items: center !important; 
            padding: 7px 14px !important; background: var(--color-2, #162032) !important; 
            border-bottom: 1px solid #1e3050 !important;
            min-height: 38px !important; flex-shrink: 0 !important; box-sizing: border-box !important; 
            width: 100% !important;
        }
        .as-sub-title { 
            font-size: 13px !important; font-weight: bold !important; color: #4aaeff !important; 
            white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; 
            flex: 1 1 auto !important; margin: 0 !important; padding: 0 !important; text-align: left !important;
        }
        .as-sub-close { 
            background: transparent !important; border: none !important; color: #fff !important; 
            font-size: 20px !important; cursor: pointer !important; padding: 0 4px !important; 
            line-height: 1 !important; margin: 0 0 0 15px !important; 
            flex: 0 0 auto !important; width: auto !important; min-width: unset !important; max-width: unset !important;
        }
        .as-sub-close:hover { color: #f66 !important; }

        #as-tx-detail-panel{display:none; flex:1; flex-direction:column; overflow:hidden;}
        #as-tx-detail-body{flex:1; overflow-y:auto; padding:10px;}
        #as-tx-detail-body::-webkit-scrollbar{width:4px;}
        #as-tx-detail-body::-webkit-scrollbar-thumb{background:#2a4a7a;border-radius:2px;}
        
        .tx-info-table{width:100%;font-size:12px;border-collapse:collapse;margin-bottom:10px;}
        .tx-info-table td{padding:3px;vertical-align:top;}
        .tx-info-table td:first-child{color:#889;white-space:nowrap;}
        .tx-info-table td:last-child{color:#fff;font-weight:bold;text-align:right;}

        .tx-freq-table { width: 100%; font-size: 12px; border-collapse: collapse; }
        .tx-freq-table td { padding: 4px; border-bottom: 1px solid #1e3050; }
        .tx-freq-table tr:last-child td { border-bottom: none; }
        
        .tx-tune-btn { cursor: pointer; transition: all 0.2s; text-decoration: none; }
        .tx-tune-btn:hover { color: #fff !important; text-shadow: 0 0 5px #4aaeff; text-decoration: underline; }

        .tx-ac-row{display:flex;justify-content:space-between;align-items:center;padding:4px;border-bottom:1px solid #1a2535;font-size:11px;}
        .tx-ac-row:hover{background:#162032;}

        #as-container{pointer-events:all;background:#111827;border-radius:0 12px 0 0;box-shadow:4px 4px 32px rgba(0,0,0,0.8);display:flex;flex-direction:column;overflow:hidden;flex:1;position:relative;}
        #as-header{display:flex;align-items:center;justify-content:space-between;padding:7px 14px;background:var(--color-2,#162032);color:#fff;cursor:move;user-select:none;min-height:38px;flex-shrink:0;}
        #as-header .as-title{font-size:14px;font-weight:bold;display:flex;align-items:center;gap:8px;}
        #as-header .as-title i{color:#4aaeff;}
        
        #as-header-info:hover { text-decoration:underline; color:#fff !important; }

        #as-reload{background:none;border:none;color:#adf;font-size:18px;cursor:pointer;padding:0 6px;line-height:1;transition:transform 0.4s;}
        #as-reload:hover{transform:rotate(180deg);color:#fff;}
        #as-reload.spinning{animation:as-spin 0.8s linear infinite;}
        @keyframes as-spin{to{transform:rotate(360deg);}}
        #as-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 4px;line-height:1;}
        #as-close:hover{color:#f66;}
        
        #as-map{flex:1;width:100%;min-height:0;position:relative;display:flex;flex-direction:column;}
        #as-leaflet-wrap{flex:1;width:100%;position:relative;}

        #as-compass{position:absolute;top:10px;right:10px;z-index:1000;background:rgba(22,32,50,0.9);border:1px solid #2a4a7a;border-radius:6px;padding:4px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:3px;box-shadow:0 2px 10px rgba(0,0,0,0.5);}
        .as-comp-btn{background:#1a2535;color:#9bb;border:1px solid #2a4a7a;border-radius:3px;width:28px;height:24px;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.1s;}
        .as-comp-btn:hover{background:#2a4a7a;color:#fff;}
        .as-comp-btn.active{background:#4aaeff;color:#000;font-weight:bold;border-color:#fff;}
        .as-comp-center{background:transparent;border:none;color:#f66;}
        .as-comp-center:hover{background:transparent;color:#f33;}
        #as-compass-lock { background: transparent !important; border: none !important; color: #fff !important; font-size: 14px !important; transition: color 0.2s; }
        #as-compass-lock:hover { color: #4aaeff !important; }
        #as-compass-lock.locked { color: #f66 !important; }

        #as-freq-filter { position:absolute; top:105px; right:10px; z-index:1000; background:rgba(22,32,50,0.9); border:1px solid #2a4a7a; border-radius:6px; padding:4px; display:flex; gap:4px; box-shadow:0 2px 10px rgba(0,0,0,0.5); width: 100px; box-sizing: border-box; justify-content: space-between; align-items: center; }
        #as-freq-filter input { width: 65px !important; height: 24px !important; min-height: 24px !important; line-height: 24px !important; box-sizing: border-box !important; background: #1a2535 !important; border: 1px solid #2a4a7a !important; color: #fff !important; border-radius: 3px !important; padding: 0 4px !important; margin: 0 !important; font-size: 11px !important; text-align: center !important; }
        #as-freq-filter input:focus { outline: none !important; border-color: #4aaeff !important; }
        #as-freq-filter input:disabled { opacity: 0.7; cursor: not-allowed; }
        #as-freq-lock { background: transparent !important; border: none !important; color: #fff !important; cursor: pointer !important; font-size: 16px !important; padding: 0 !important; margin: 0 !important; display: flex !important; align-items: center !important; justify-content: center !important; width: 20px !important; height: 24px !important; line-height: 1 !important; transition: color 0.2s; }
        #as-freq-lock:hover { color: #4aaeff !important; }
        #as-freq-lock.locked { color: #f66 !important; }
        
        #as-statusbar{background:#0d1420;color:#9bb;font-size:11px;padding:5px 12px;display:flex;gap:14px;align-items:center;flex-wrap:wrap;border-top:1px solid #1e3050;flex-shrink:0; padding-right: 25px;}
        .as-dot{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;margin-right:3px;}
        
        #as-resizer {
            position: absolute; right: 2px; bottom: 2px; width: 16px; height: 16px; cursor: nwse-resize; z-index: 10;
            background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%2388aadd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v6h-6M21 21l-7-7M3 9V3h6M3 3l7 7"/></svg>') center/contain no-repeat;
        }
        
        .as-countdown-cell{font-size:13px;font-weight:bold;}
        .as-countdown-neg{color:#f55;}
        .as-countdown-zero{color:#4f4;}
        .as-countdown-pos{color:#5af;}
        
        .as-ac-tooltip { background: rgba(17,24,39,0.95) !important; border: 1px solid #4aaeff !important; color: #fff !important; font-size: 12px; padding: 10px 12px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.6); }
        .as-ac-tooltip b { color: #4aaeff; font-size: 13px; }

        #AIRPLANESCATTER-on-off.active{background-color:var(--color-2,#162032)!important;filter:brightness(130%);}
        #AIRPLANESCATTER-on-off:hover{color:var(--color-5,#4af);filter:brightness(120%);}
        .as-fade-in{animation:as-fi 0.4s forwards;}
        .as-fade-out{animation:as-fo 0.4s forwards;}
        @keyframes as-fi{from{opacity:0}to{opacity:1}}
        @keyframes as-fo{from{opacity:1}to{opacity:0}}
        
        #as-settings-btn{background:none;border:none;color:#adf;font-size:15px;cursor:pointer;padding:0 6px;line-height:1;}
        #as-settings-btn:hover{color:#fff;}
        #as-settings-panel{display:none;position:absolute;top:42px;right:40px;z-index:10001;background:#1a2535;border:1px solid #2a4a7a;border-radius:8px;padding:14px 18px 12px;min-width:320px;box-shadow:0 4px 24px rgba(0,0,0,0.7);font-size:12px;color:#cde;}
        #as-settings-panel h5{margin:0 0 10px;font-size:13px;color:#4aaeff;border-bottom:1px solid #2a4a7a;padding-bottom:6px; display:flex; justify-content:space-between; align-items:center;}
        #as-settings-close{background:none; border:none; color:#fff; cursor:pointer; font-size:14px; line-height:1; padding:0; margin:0;}
        #as-settings-close:hover{color:#f66;}

        .as-setting-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;gap:8px;}
        .as-setting-row label{flex:1;color:#9bb;white-space:nowrap;}
        .as-setting-row input[type=number], .as-setting-row input[type=text]{width:80px;height:24px!important;min-height:24px!important;background:#0d1420;border:1px solid #2a4a7a;color:#fff;border-radius:4px!important;padding:2px 6px;font-size:12px;text-align:right; box-sizing:border-box;}
        .as-setting-row input[type=text]{padding-right:20px;} 
        .as-setting-row input:focus{outline:none;border-color:#4aaeff;}
        .as-setting-unit{color:#668;min-width:36px;}
        
        #as-settings-apply{margin-top:10px;width:100%;padding:6px;background:#1a6de0!important;color:#fff!important;border:none!important;border-radius:5px!important;cursor:pointer;font-size:12px;height:auto!important;line-height:normal!important;}
        #as-settings-apply:hover{background:#2a7df0!important;}
        #as-settings-reset{margin-top:5px;width:100%;padding:5px;background:#2a3545!important;color:#9bb!important;border:1px solid #2a4a7a!important;border-radius:5px!important;cursor:pointer;font-size:11px;height:auto!important;line-height:normal!important;}
        #as-settings-reset:hover{background:#3a4555!important;color:#fff!important;}

        #as-profile-panel {
            height: 180px; flex-shrink: 0; box-sizing: border-box;
            background: rgba(17, 24, 39, 0.98); border-top: 1px solid #2a4a7a;
            display: none; flex-direction: column; width: 100%; position: relative; z-index:10;
        }
        #as-profile-canvas {
            flex: 1; width: 100%; display: block; cursor: grab;
        }
        #as-profile-canvas:active { cursor: grabbing; }
		
        #as-profile-y-zoom-container {
            position: absolute; right: 0px; top: 0; bottom: 0; width: 35px;
            display: flex; align-items: center; justify-content: center; z-index: 20;
        }
        #as-profile-y-zoom {
            transform: rotate(-90deg); 
            width: 90px !important; 
            min-width: 90px !important; 
            height: 8px !important; 
            flex-shrink: 0 !important; 
            margin: 0 !important;
            padding: 0 !important;
            -webkit-appearance: none; 
            background: #1e3050; 
            border-radius: 2px; 
            outline: none;
        }
        #as-profile-y-zoom::-webkit-slider-thumb {
            -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
            background: #4aaeff; cursor: ns-resize; border: 2px solid #1a2535;
        }
        #as-profile-y-zoom::-webkit-slider-thumb:hover { background: #fff; }
		#as-help-btn{text-decoration:none!important;}
        #as-help-btn:hover{color:#fff!important;text-decoration:none!important;}
    `;
    document.head.appendChild(style);

    // ── Geo helpers ───────────────────────────────────────────────────────
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;

    function haversineKm(lat1,lon1,lat2,lon2){
        const R=6371,dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);
        const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
        return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
    }
    function bearingDeg(lat1,lon1,lat2,lon2){
        const f1=toRad(lat1),f2=toRad(lat2),dl=toRad(lon2-lon1);
        return (toDeg(Math.atan2(Math.sin(dl)*Math.cos(f2),Math.cos(f1)*Math.sin(f2)-Math.sin(f1)*Math.cos(f2)*Math.cos(dl)))+360)%360;
    }
    function normalizeAngle180(a){ a=((a%360)+360)%360; return a>180?a-360:a; }

    function toVec(lat,lon){ return [Math.cos(toRad(lat))*Math.cos(toRad(lon)),Math.cos(toRad(lat))*Math.sin(toRad(lon)),Math.sin(toRad(lat))]; }
    function fromVec(v){ return {lat:toDeg(Math.asin(v[2])),lon:toDeg(Math.atan2(v[1],v[0]))}; }
    function dot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
    function cross(a,b){ return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
    function normalize(v){ const m=Math.sqrt(dot(v,v)); return [v[0]/m,v[1]/m,v[2]/m]; }

    function midpointGreatCircle(lat1,lon1,lat2,lon2){
        const f1=toRad(lat1),f2=toRad(lat2),l1=toRad(lon1),l2=toRad(lon2);
        const Bx=Math.cos(f2)*Math.cos(l2-l1),By=Math.cos(f2)*Math.sin(l2-l1);
        const fm=Math.atan2(Math.sin(f1)+Math.sin(f2),Math.sqrt((Math.cos(f1)+Bx)**2+By**2));
        return {lat:toDeg(fm),lon:toDeg(l1+Math.atan2(By,Math.cos(f1)+Bx))};
    }

    function gcIntersectionPoint(txLat,txLon,rxLat,rxLon,acLat,acLon,acTrackDeg){
        const vTx=toVec(txLat,txLon),vRx=toVec(rxLat,rxLon);
        const nTxRx=normalize(cross(vTx,vRx));
        const ahead=deadReckonRad(acLat,acLon,acTrackDeg,111.2);
        const nAc=normalize(cross(toVec(acLat,acLon),toVec(ahead.lat,ahead.lon)));
        const inter=normalize(cross(nTxRx,nAc));
        const p1=fromVec(inter),p2=fromVec([-inter[0],-inter[1],-inter[2]]);
        const best=haversineKm(acLat,acLon,p1.lat,p1.lon)<haversineKm(acLat,acLon,p2.lat,p2.lon)?p1:p2;
        const dTxRx=haversineKm(txLat,txLon,rxLat,rxLon);
        if(haversineKm(best.lat,best.lon,txLat,txLon)>dTxRx||haversineKm(best.lat,best.lon,rxLat,rxLon)>dTxRx)
            return midpointGreatCircle(txLat,txLon,rxLat,rxLon);
        return best;
    }

    function deadReckonRad(lat,lon,trackDeg,distKm){
        const d=distKm/6371,f=toRad(lat),l=toRad(lon),t=toRad(trackDeg);
        const lat2=Math.asin(Math.sin(f)*Math.cos(d)+Math.cos(f)*Math.sin(d)*Math.cos(t));
        const lon2=l+Math.atan2(Math.sin(t)*Math.sin(d)*Math.cos(f),Math.cos(d)-Math.sin(f)*Math.sin(lat2));
        return {lat:toDeg(lat2),lon:toDeg(lon2)};
    }
    function deadReckon(lat,lon,trackDeg,speedKts,dtSec){
        return deadReckonRad(lat,lon,trackDeg,(speedKts*1.852/3600)*dtSec);
    }
    
    function radioHorizonKm(h1m,h2m){ return 4.12*(Math.sqrt(Math.max(0,h1m))+Math.sqrt(Math.max(0,h2m))); }

    function crossAlongTrack(aLat,aLon,bLat,bLon,pLat,pLon){
        const d13 = haversineKm(aLat,aLon,pLat,pLon);
        const t13 = bearingDeg(aLat,aLon,pLat,pLon);
        const t12 = bearingDeg(aLat,aLon,bLat,bLon);
        const angleRad = toRad(normalizeAngle180(t13 - t12));
        return {
            crossTrackKm: Math.abs(d13 * Math.sin(angleRad)),
            alongTrackKm: d13 * Math.cos(angleRad)
        };
    }

    function generatePathPoints(lat1, lon1, lat2, lon2, numPoints) {
        const d = haversineKm(lat1, lon1, lat2, lon2);
        const brg = bearingDeg(lat1, lon1, lat2, lon2);
        const pts = [];
        for (let i = 0; i < numPoints; i++) {
            const dist = (i / (numPoints - 1)) * d;
            pts.push(deadReckonRad(lat1, lon1, brg, dist));
        }
        return pts;
    }

    function txSiblings(tx) {
        return txStations
            .filter(t => Math.abs(t.lat-tx.lat)<0.0001 && Math.abs(t.lon-tx.lon)<0.0001)
            .sort((a,b) => b.erp - a.erp);
    }

    function gridKey(lat,lon){ return Math.floor(lat/5)+'_'+Math.floor(lon/5); }
    
	async function buildTxGridAsync(stations) {
        const g = {};
        let lastYield = performance.now();
        for (let i = 0; i < stations.length; i++) {
            if (performance.now() - lastYield > 10) {
                await new Promise(r => setTimeout(r, 5)); // Give the browser time for Audio/UI
                lastYield = performance.now();
            }
            const tx = stations[i];
            const k = gridKey(tx.lat, tx.lon);
            if (!g[k]) g[k] = [];
            g[k].push(tx);
        }
        return g;
    }
	
    function nearbyTx(acLat,acLon){
        const r=[];
        for(let dlat=-1;dlat<=1;dlat++) for(let dlon=-1;dlon<=1;dlon++){
            const k=(Math.floor(acLat/5)+dlat)+'_'+(Math.floor(acLon/5)+dlon);
            if(txStationGrid[k]) r.push(...txStationGrid[k]);
        }
        return r;
    }

    // ── Scoring Helpers ───────────────────────────────────────────────────
    function reflectionGeometryScore(txLat, txLon, acLat, acLon, rxLat, rxLon) {
        const vTx = toVec(txLat, txLon), vRx = toVec(rxLat, rxLon), vAc = toVec(acLat, acLon);
        const i = normalize([vTx[0]-vAc[0], vTx[1]-vAc[1], vTx[2]-vAc[2]]);
        const o = normalize([vRx[0]-vAc[0], vRx[1]-vAc[1], vRx[2]-vAc[2]]);
        const angleDeg = toDeg(Math.acos(Math.max(-1, Math.min(1, dot(i, o)))));
        const diff = angleDeg - 40;
        return { reflScore: Math.exp(-(diff*diff)/(2*25*25)), reflAngleDeg: angleDeg };
    }

    function fuselageAlignmentScore(acTrackDeg, txLat, txLon, acLat, acLon, rxLat, rxLon){
        if(acTrackDeg===null||acTrackDeg===undefined) return 0.5;
        const bTx = bearingDeg(acLat, acLon, txLat, txLon);
        const bRx = bearingDeg(acLat, acLon, rxLat, rxLon);
        const optimalTrack = ((bTx + normalizeAngle180(bRx - bTx)/2 + 360) % 360 + 90) % 360;
        let trackDiff = Math.abs(normalizeAngle180(acTrackDeg - optimalTrack));
        if (trackDiff > 90) trackDiff = 180 - trackDiff; 
        return 0.3 + 0.7 * Math.max(0, Math.cos(toRad(trackDiff))); 
    }

    function _evalScatterAt(acLat,acLon,acAltFt,acTrackDeg,acCategory,rxLat,rxLon,rxElevM,tx){
        const txLat=parseFloat(tx.lat),txLon=parseFloat(tx.lon);
        const altM=acAltFt*0.3048, txEffM=(tx.terrainM||0)+TX_HEIGHT_DEFAULT_M;
        const d_tx=haversineKm(acLat,acLon,txLat,txLon), d_rx=haversineKm(acLat,acLon,rxLat,rxLon), d_txrx=haversineKm(txLat,txLon,rxLat,rxLon);

        if(d_tx < 5 || d_rx < 5 || d_txrx<S.minTxRxDistKm) return null; 
        
        // Dynamic elevation limit (9 degrees) for transmitting & receiving antenna
        const elevAngleTx = toDeg(Math.atan2(Math.max(0, altM - txEffM) / 1000, d_tx));
        const elevAngleRx = toDeg(Math.atan2(Math.max(0, altM - rxElevM) / 1000, d_rx));
        if (elevAngleTx > 9 || elevAngleRx > 9) return null;

        if(d_tx>radioHorizonKm(txEffM,altM) || d_rx>radioHorizonKm(rxElevM,altM)) return null;
        
        const dynamicEllipseFactor = 1.02 + Math.min(1.0, altM / 12000) * 0.06;
        if(d_tx+d_rx>dynamicEllipseFactor*d_txrx) return null;

        const {crossTrackKm,alongTrackKm}=crossAlongTrack(txLat,txLon,rxLat,rxLon,acLat,acLon);
        if(alongTrackKm>d_txrx*1.1) return null;

        const { reflScore } = reflectionGeometryScore(txLat,txLon,acLat,acLon,rxLat,rxLon);
        const fuseScore=fuselageAlignmentScore(acTrackDeg,txLat,txLon,acLat,acLon,rxLat,rxLon);
        const altScore=Math.max(0, Math.min(1, Math.log((altM)/1500)/Math.log(12000/1500)));
        const freqFactor=1.0 - 0.03 * ((tx.freq - 98) / 20.5);
        const erpScoreVal=Math.min(1.0, Math.log10(tx.erp/10+1) / Math.log10(101));
        const distScore=Math.exp(-crossTrackKm/25);
        const sizeMult=acSizeMult(acCategory);

        const baseScore = distScore*30 + reflScore*25 + altScore*15 + fuseScore*10 + erpScoreVal*10 + (freqFactor-0.97)/0.06*5;
        return { score:Math.max(0, Math.min(100,Math.round(baseScore * sizeMult))), crossTrackKm };
    }

    function calcScatter(ac, rxLat, rxLon, rxElevM, tx){
        if(!ac.lat||!ac.lon||isNaN(ac.lat)||isNaN(ac.lon)) return null;
        if((ac.speed||0)<50 || (ac.alt_ft||0)<1000) return null; 
        
        const txLat=parseFloat(tx.lat),txLon=parseFloat(tx.lon);
        const crossPt=(ac.track!==null)?gcIntersectionPoint(txLat,txLon,rxLat,rxLon,ac.lat,ac.lon,ac.track):midpointGreatCircle(txLat,txLon,rxLat,rxLon);
        const speedKmS=((ac.speed||0)*1.852)/3600;
        if(speedKmS<=0) return null;

        const distToCross=haversineKm(ac.lat,ac.lon,crossPt.lat,crossPt.lon);
        let etaSec=distToCross/speedKmS;
        if(ac.track!==null){
            const brgToCross=bearingDeg(ac.lat,ac.lon,crossPt.lat,crossPt.lon);
            if(Math.abs(normalizeAngle180(ac.track-brgToCross))>90) etaSec = -etaSec;
        }

        let bestScore=0;
        for(const dtSec of FORECAST_STEPS_SEC){
            let fLat=ac.lat,fLon=ac.lon, fAltFt=ac.alt_ft + ((ac.vspeed||0)/60)*dtSec;
            if(ac.track!==null&&ac.speed>0){ const p=deadReckon(ac.lat,ac.lon,ac.track,ac.speed,dtSec); fLat=p.lat; fLon=p.lon; }
            if(fAltFt<1000) continue;
            const r=_evalScatterAt(fLat,fLon,fAltFt,ac.track,ac.category,rxLat,rxLon,rxElevM,tx);
            if(r && r.score>bestScore) bestScore=r.score;
        }

        return { score: bestScore, etaSec, crossPt };
    }

    // ── Persistent Candidates Processing (Async Chunked & Decoupled) ──────
    async function computePersistentCrossings(robustAircraftList, rxLat, rxLon) {
        if(!txStations||txStations.length===0) return;
        const activeIcaos = new Set(robustAircraftList.map(a=>a.icao24));

        for (let icao in _persistentCrossings) {
            if (!activeIcaos.has(icao)) delete _persistentCrossings[icao];
        }

        let lastYield = performance.now();
        for (let i = 0; i < robustAircraftList.length; i++) {
            if (performance.now() - lastYield > 10) {
                await new Promise(r => setTimeout(r, 5)); 
                lastYield = performance.now();
            }

            const ac = robustAircraftList[i];
            if(!ac.lat||!ac.lon) continue;
            
            if(!_persistentCrossings[ac.icao24]) _persistentCrossings[ac.icao24] = {};
            const crossings = _persistentCrossings[ac.icao24];
            
            const nearby = nearbyTx(ac.lat, ac.lon);
            const currentCalcTime = Date.now(); 
            
            for(let j = 0; j < nearby.length; j++) {
                const tx = nearby[j];
                const txKey = tx.lat+'_'+tx.lon+'_'+tx.freq;
                const r = calcScatter(ac, rxLat, rxLon, _rxElevM, tx);
                
                if (r) {
                    if (crossings[txKey]) {
                        crossings[txKey].etaSec = r.etaSec;
                        crossings[txKey].ac = ac; 
                        crossings[txKey].score = r.score;
                        crossings[txKey].calcTime = currentCalcTime;
                    } else if (r.score >= S.minScore) {
                        crossings[txKey] = { tx, ac, etaSec: r.etaSec, score: r.score, calcTime: currentCalcTime };
                    }
                }
            }

            for (let tK in crossings) {
                const liveEta = crossings[tK].etaSec - ((currentCalcTime - crossings[tK].calcTime)/1000);
                if (liveEta < -S.trailTimeSec) {
                    delete crossings[tK];
                }
            }
            if (Object.keys(crossings).length === 0) delete _persistentCrossings[ac.icao24];
        }
    }

    function updateCompassFromRotor() {
        if (!isCompassLocked || lastRotorAzimuth === null) return;
        const az = lastRotorAzimuth;
        let dirs = [];
        
        // 360 degrees divided into 16 sectors of 22.5 degrees each
        if (az >= 348.75 || az < 11.25) dirs = ['N'];
        else if (az >= 11.25 && az < 33.75) dirs = ['N', 'NO'];
        else if (az >= 33.75 && az < 56.25) dirs = ['NO'];
        else if (az >= 56.25 && az < 78.75) dirs = ['NO', 'O'];
        else if (az >= 78.75 && az < 101.25) dirs = ['O'];
        else if (az >= 101.25 && az < 123.75) dirs = ['O', 'SO'];
        else if (az >= 123.75 && az < 146.25) dirs = ['SO'];
        else if (az >= 146.25 && az < 168.75) dirs = ['SO', 'S'];
        else if (az >= 168.75 && az < 191.25) dirs = ['S'];
        else if (az >= 191.25 && az < 213.75) dirs = ['S', 'SW'];
        else if (az >= 213.75 && az < 236.25) dirs = ['SW'];
        else if (az >= 236.25 && az < 258.75) dirs = ['SW', 'W'];
        else if (az >= 258.75 && az < 281.25) dirs = ['W'];
        else if (az >= 281.25 && az < 303.75) dirs = ['W', 'NW'];
        else if (az >= 303.75 && az < 326.25) dirs = ['NW'];
        else if (az >= 326.25 && az < 348.75) dirs = ['NW', 'N'];

        _activeCompass = dirs;
        // DO NOT delete the selected station anymore!
        // _activeTxKey = null; 
        updateCompassUI();
    }

    function getActiveVisibleCrossings() {
        const rx = getRxCoords(); if(!rx) return [];
        const out = [];
        const now = Date.now();
        for (let icao in _persistentCrossings) {
            for (let tK in _persistentCrossings[icao]) {
                const cr = _persistentCrossings[icao][tK];
                const elapsed = (now - cr.calcTime) / 1000;
                const liveEta = cr.etaSec - elapsed;
                
                if (liveEta <= S.leadTimeSec && liveEta >= -S.trailTimeSec) {
                    
                    // Priority 1: If a station is explicitly selected
                    if (_activeTxKey) {
                        if (tK !== _activeTxKey) continue;
                        // Ignore all background filters so the station remains open!
                        out.push({...cr, liveEta, elapsed});
                        continue;
                    }
                    
                    // Priority 2: Normal filtering (compass directions)
                    if (_activeCompass && _activeCompass.length > 0) {
                        const brg = bearingDeg(rx.lat, rx.lon, cr.tx.lat, cr.tx.lon);
                        const dirs = {N:[337.5,22.5], NO:[22.5,67.5], O:[67.5,112.5], SO:[112.5,157.5], S:[157.5,202.5], SW:[202.5,247.5], W:[247.5,292.5], NW:[292.5,337.5]};
                        
                        let isMatch = false;
                        for (let dir of _activeCompass) {
                            const d = dirs[dir];
                            if (d) {
                                const match = d[0]>d[1] ? (brg>=d[0]||brg<d[1]) : (brg>=d[0]&&brg<d[1]);
                                if (match) {
                                    isMatch = true;
                                    break;
                                }
                            }
                        }
                        if (!isMatch) continue;
                    }
                    
                    // Priority 3: Normal filtering (frequency)
                    if (_activeFreq !== null) {
                        const match = txSiblings(cr.tx).some(t => Math.round(t.freq*100)===Math.round(_activeFreq*100));
                        if (!match) continue;
                    }
                    
                    out.push({...cr, liveEta, elapsed});
                }
            }
        }
        return out;
    }

    function getPrimaryCrossings(allCrossings) {
        const groups = {};
        allCrossings.forEach(cr => {
            if(!groups[cr.ac.icao24]) groups[cr.ac.icao24] = [];
            groups[cr.ac.icao24].push(cr);
        });
        
        const primary = [];
        Object.values(groups).forEach(crs => {
            const activeNow = crs.find(c => Math.abs(c.liveEta) <= 5);
            if (activeNow) {
                primary.push(activeNow);
            } else {
                const upcoming = crs.filter(c => c.liveEta >= 0).sort((a,b) => a.liveEta - b.liveEta);
                const past = crs.filter(c => c.liveEta < 0).sort((a,b) => b.liveEta - a.liveEta);
                if (upcoming.length > 0) primary.push(upcoming[0]);
                else if (past.length > 0) primary.push(past[0]);
            }
        });
        return primary;
    }

    // ── Output Formatters ─────────────────────────────────────────────────
    function fmtEta(liveEta){
        if(Math.abs(liveEta)<=5) return 'NOW ✓';
        const sign=liveEta<0?'+':'−', abs=Math.abs(Math.round(liveEta));
        return sign+Math.floor(abs/60)+':'+String(abs%60).padStart(2,'0');
    }
    function etaClass(liveEta){
        if(Math.abs(liveEta)<=5) return 'as-countdown-zero';
        return liveEta>0?'as-countdown-neg':'as-countdown-pos';
    }
    const scoreColor=s=>s>=SCORE_EXCELLENT?'#ff3300':s>=SCORE_HIGH?'#ff8800':s>=SCORE_MEDIUM?'#eecc00':'#44cc44';

    function updateStatusText(msg, acCnt, txCnt, candCnt){
        const g=id=>document.getElementById(id);
        if(g('as-stat-ac'))   g('as-stat-ac').textContent  =`✈ ${acCnt} aircraft`;
        if(g('as-stat-cand')) g('as-stat-cand').textContent=`📡 ${candCnt} active`;
        if(g('as-stat-db'))   g('as-stat-db').textContent  =`DB: ${txCnt} TX`;
        if(g('as-stat-msg')) {
            g('as-stat-msg').textContent = msg || '';
            g('as-stat-msg').style.color = msg && msg.includes('⚠') ? '#f66' : '#9bb';
        }
    }

    // ── Aircraft Icons ────────────────────────────────────────────────────
    function planeIcon(trackDeg, color, opacity, category){
        const deg=isNaN(trackDeg)?0:trackDeg;
        const mult = acSizeMult(category);
        const w=Math.round(28 * mult), h=Math.round(28 * mult);
        const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 28 28" style="filter:drop-shadow(0 0 2px #000a)"><g transform="rotate(${deg},14,14)"><ellipse cx="14" cy="14" rx="2.8" ry="11" fill="${color}" stroke="#000" stroke-width="0.7"/><ellipse cx="14" cy="12" rx="12" ry="2.5" fill="${color}" stroke="#000" stroke-width="0.7"/><ellipse cx="14" cy="22" rx="5" ry="1.6" fill="${color}" stroke="#000" stroke-width="0.7"/></g></svg>`;
        return L.divIcon({html:`<div style="opacity:${opacity||1}">${svg}</div>`,className:'',iconSize:[w,h],iconAnchor:[w/2,h/2]});
    }
    function txDotIcon(color, erp, highlighted){
        const r=erp>=500?14:erp>=200?11:erp>=50?9:erp>=10?7:5;
        const ring=highlighted?`box-shadow:0 0 0 3px #fff,0 0 ${r+4}px ${color};`:'';
        return L.divIcon({html:`<div style="width:${r*2}px;height:${r*2}px;border-radius:50%;background:${color};border:2px solid #fff;${ring}opacity:0.92;"></div>`,className:'',iconSize:[r*2,r*2],iconAnchor:[r,r]});
    }

    // ── RX & TX Tooltips ──────────────────────────────────────────────────
    function updateRxMarkerTooltip(rx) {
        if(!rxMarker) return;
        const isGps = (gpsLat && gpsLon && gpsLat === rx.lat && gpsLon === rx.lon) ? '<span style="color:#00ee44; font-size:11px; margin-left:6px; vertical-align:middle;">[GPS]</span>' : '';
        
        let rxItu = '';
        if (txStations && txStations.length > 0) {
            const closest = txStations.reduce((prev, curr) => (prev.dist < curr.dist) ? prev : curr);
            if (closest) rxItu = closest.itu;
        }
        const flagHtml = getFlagImg(rxItu, 24, 18);

        const rxTtHtml = `
            <div class="as-ac-tooltip" style="min-width:200px;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
                    <div style="font-size:15px; font-weight:bold; color:#fff;">
                        <span style="color:#4aaeff;">📡 Receiver QTH</span>${isGps}
                    </div>
                    ${flagHtml ? `<div style="margin-left:10px;">${flagHtml}</div>` : ''}
                </div>
                <table class="tx-info-table">
                    <tr><td>Latitude</td><td style="text-align:right;">${rx.lat.toFixed(4)}°</td></tr>
                    <tr><td>Longitude</td><td style="text-align:right;">${rx.lon.toFixed(4)}°</td></tr>
                    <tr><td>Terrain</td><td style="text-align:right;">${Math.round(_rxTerrainM)} m</td></tr>
                    <tr><td>Antenna (AGL)</td><td style="text-align:right;">${S.rxAglM} m</td></tr>
                </table>
            </div>`;
            
        if (!rxMarker.getTooltip()) {
            rxMarker.bindTooltip(rxTtHtml, {direction: 'top', sticky: true, className: 'as-ac-tooltip-wrap', opacity: 1});
        } else {
            rxMarker.setTooltipContent(rxTtHtml);
        }
        rxMarker.setLatLng([rx.lat, rx.lon]);
    }

    function buildTxTooltip(tx, rxLat, rxLon) {
        const siblings = txSiblings(tx);
        const progsRows = siblings.map(t => {
            const progName = t.station || t.ps || '?';
            return `
            <tr>
                <td style="color:#4aaeff; white-space:nowrap; padding-right:8px;">${t.freq.toFixed(2)} MHz</td>
                <td style="color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width: 120px;">${progName}</td>
                <td style="color:#889; text-align:center; padding:0 8px;">${(t.pol||'').toLowerCase()}</td>
                <td style="color:#cde; text-align:right; white-space:nowrap;">${t.erp} kW</td>
            </tr>
            `;
        }).join('');
        
        const distStr = S.useMetric ? tx.dist + ' km' : Math.round(tx.dist * 0.621371) + ' mi';
        const flagHtml = getFlagImg(tx.itu, 24, 18);
        
        return `
            <div class="as-ac-tooltip" style="min-width:260px;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
                    <div style="font-size:15px; font-weight:bold; color:#fff;">${tx.city} [${tx.itu}]</div>
                    ${flagHtml ? `<div style="margin-left:10px;">${flagHtml}</div>` : ''}
                </div>
                <table class="tx-info-table">
                    <tr><td>Distance</td><td style="text-align:right;">${distStr}</td></tr>
                    <tr><td>Azimuth</td><td style="text-align:right;">${Math.round(bearingDeg(rxLat, rxLon, tx.lat, tx.lon))}°</td></tr>
                    <tr><td>Terrain</td><td style="text-align:right;">${tx.terrainM||0} m</td></tr>
                </table>
                <div style="background:var(--color-2,#162032); padding:6px; border-radius:6px; margin-top:10px;">
                    <table class="tx-freq-table">${progsRows}</table>
                </div>
            </div>
        `;
    }

    // ── Elevation Profile Render Logic ────────────────────────────────────
    function resizeProfileCanvas() {
        const panel = document.getElementById('as-profile-panel');
        const canvas = document.getElementById('as-profile-canvas');
        if(panel && canvas) {
            canvas.width = panel.clientWidth;
            canvas.height = panel.clientHeight - 38; 
        }
    }

    function initProfileCanvasEvents() {
        const canvas = document.getElementById('as-profile-canvas');
        if(!canvas) return;

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if(!_activeProfileTxKey) return;
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const w = canvas.width;
            const padL = 45, padR = 25, drawW = w - padL - padR;
            if(mouseX < padL || mouseX > w - padR) return;

            const range = profMaxX - profMinX;
            const mouseKm = profMinX + ((mouseX - padL) / drawW) * range;

            const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85;
            let newRange = range * zoomFactor;

            if(newRange > _currentProfileDist) newRange = _currentProfileDist;
            if(newRange < 5) newRange = 5; 

            let newMin = mouseKm - ((mouseX - padL) / drawW) * newRange;
            let newMax = newMin + newRange;

            if (newMin < 0) {
                newMax -= newMin;
                newMin = 0;
            }
            if (newMax > _currentProfileDist) {
                newMin -= (newMax - _currentProfileDist);
                newMax = _currentProfileDist;
            }
            
            if (newMin < 0) newMin = 0;
            if (newMax > _currentProfileDist) newMax = _currentProfileDist;

            profMinX = newMin;
            profMaxX = newMax;
            redrawActiveProfile();
        });

        canvas.addEventListener('mousedown', (e) => { 
            if(_activeProfileTxKey){ isDraggingProf = true; lastMouseX = e.clientX; } 
        });
        window.addEventListener('mouseup', () => isDraggingProf = false);
        window.addEventListener('mousemove', (e) => {
            if(!isDraggingProf || !_activeProfileTxKey) return;
            const dx = e.clientX - lastMouseX; 
            lastMouseX = e.clientX;
            
            const w = canvas.width;
            const drawW = w - 45 - 25;
            const range = profMaxX - profMinX;
            
            const shiftKm = -(dx / drawW) * range;

            let newMin = profMinX + shiftKm;
            let newMax = profMaxX + shiftKm;

            if(newMin < 0) { 
                newMin = 0; newMax = range; 
            } else if(newMax > _currentProfileDist) { 
                newMax = _currentProfileDist; newMin = _currentProfileDist - range; 
            }
            
            profMinX = newMin; 
            profMaxX = newMax; 
            redrawActiveProfile();
        });
		const yZoom = document.getElementById('as-profile-y-zoom');
        if(yZoom) {
            yZoom.addEventListener('input', (e) => {
                profScaleY = parseFloat(e.target.value);
                redrawActiveProfile();
            });
            yZoom.addEventListener('dblclick', (e) => {
                e.target.value = 1.0;
                profScaleY = 1.0;
                redrawActiveProfile();
            });
        }
    }

    function redrawActiveProfile() {
        if(!_activeProfileTxKey || !_activeProfileTxObj) return;
        const rx = getRxCoords(); if(!rx) return;
        
        const allVisible = getActiveVisibleCrossings();
        const matchingCrs = allVisible.filter(c => (c.tx.lat+'_'+c.tx.lon+'_'+c.tx.freq) === _activeProfileTxKey);
        
        drawProfile(matchingCrs, _currentPathElevs, rx, _activeProfileTxObj);
    }

    function drawProfile(cands, elevs, rx, tx) {
        const canvas = document.getElementById('as-profile-canvas');
        if(!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const d_txrx = haversineKm(tx.lat, tx.lon, rx.lat, rx.lon);
        _currentProfileDist = d_txrx;

        if (profMaxX === 0) { profMinX = 0; profMaxX = d_txrx; }

        const txAltM = (tx.terrainM || 0) + TX_HEIGHT_DEFAULT_M;
        const rxAltM = _rxElevM;

        const padT = 35, padB = 25, padL = 45, padR = 35;
        const drawW = w - padL - padR, drawH = h - padT - padB;

        if (!elevs || elevs.length === 0) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(padL, padT, drawW, drawH);
            ctx.fillStyle = '#adf'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('⏳ Fetching Topography Data...', padL + drawW/2, padT + drawH/2);
            return; 
        }

        const losFloor = [];
        const stepKm = d_txrx / (elevs.length - 1);
        const c_factor = 16.974;

        let m_max_rx = -Infinity;
        const hrx_arr = new Float64Array(elevs.length);
        for (let i = 0; i < elevs.length; i++) {
            const x = i * stepKm;
            if (x === 0) { hrx_arr[i] = rxAltM; } 
            else {
                const c_drop = (x * x) / c_factor; 
                const m = (elevs[i] - rxAltM - c_drop) / x; 
                if (m > m_max_rx) m_max_rx = m; 
                hrx_arr[i] = rxAltM + m_max_rx * x + c_drop;
            }
        }

        let m_max_tx = -Infinity;
        const htx_arr = new Float64Array(elevs.length);
        for (let i = elevs.length - 1; i >= 0; i--) {
            const d_tx = d_txrx - (i * stepKm); 
            if (d_tx === 0) { htx_arr[i] = txAltM; } 
            else {
                const c_drop = (d_tx * d_tx) / c_factor;
                const m = (elevs[i] - txAltM - c_drop) / d_tx;
                if (m > m_max_tx) m_max_tx = m;
                htx_arr[i] = txAltM + m_max_tx * d_tx + c_drop;
            }
        }

        let minPurpleH = Infinity; 
        for (let i = 0; i < elevs.length; i++) {
            const ptMax = Math.max(hrx_arr[i], htx_arr[i]);
            losFloor.push({ x: i * stepKm, hrx: hrx_arr[i], htx: htx_arr[i], max: ptMax });
            if (ptMax < minPurpleH) minPurpleH = ptMax;
        }

        const planeData = [];
        cands.forEach(cr => {
            let drLat = cr.ac.lat, drLon = cr.ac.lon;
            if (cr.ac.track !== null && cr.ac.speed > 0) {
                const p = deadReckon(cr.ac.lat, cr.ac.lon, cr.ac.track, cr.ac.speed, cr.elapsed);
                drLat = p.lat; drLon = p.lon;
            }
            const {alongTrackKm} = crossAlongTrack(rx.lat, rx.lon, tx.lat, tx.lon, drLat, drLon);
            const acX = alongTrackKm;
            const acAltM = (cr.ac.alt_ft||0)*0.3048;
            planeData.push({ cr, acX, acAltM, ac: cr.ac });
        });

        let maxH = Math.max(12000, (minPurpleH !== Infinity ? minPurpleH + 1000 : 12000));
        let minH = 0; 

        for(let i=0; i<elevs.length; i++){ if(elevs[i] > maxH) maxH = elevs[i]; }
        if (rxAltM > maxH) maxH = rxAltM;
        if (txAltM > maxH) maxH = txAltM;
        planeData.forEach(p => { if(p.acAltM > maxH) maxH = p.acAltM; });

        maxH *= 1.2; 
        maxH /= profScaleY; 

        const scaleX = drawW / (profMaxX - profMinX), scaleY = drawH / (maxH - minH);
        const mapX = xKm => padL + (xKm - profMinX) * scaleX;
        const mapY = zM => h - padB - (zM - minH) * scaleY;

        ctx.fillStyle = '#668'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (let i = 0; i <= 4; i++) {
            const levelM = minH + (maxH - minH) * (i / 4);
            const yCanvas = mapY(levelM);
            ctx.fillText(Math.round(levelM) + 'm', padL - 5, yCanvas);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(padL, yCanvas); ctx.lineTo(w - padR, yCanvas); ctx.stroke();
        }

        ctx.save(); ctx.beginPath(); ctx.rect(padL, padT, drawW, drawH); ctx.clip();

        let highestPlaneM = 12000;
        if (planeData.length > 0) {
            highestPlaneM = Math.max(12000, Math.max(...planeData.map(p => p.acAltM)) + 1000);
        } else if (minPurpleH !== Infinity && minPurpleH < 12000) {
            highestPlaneM = 12000;
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(padL, mapY(highestPlaneM), drawW, (h - padB) - mapY(highestPlaneM));
        ctx.clip();

        ctx.beginPath();
        let first = true;
        losFloor.forEach(pt => {
            if (first) { ctx.moveTo(mapX(pt.x), mapY(pt.max)); first = false; }
            else ctx.lineTo(mapX(pt.x), mapY(pt.max));
        });
        if (!first) {
            ctx.lineTo(mapX(d_txrx), mapY(highestPlaneM));
            ctx.lineTo(mapX(0), mapY(highestPlaneM));
            ctx.fillStyle = 'rgba(200, 50, 255, 0.25)'; 
            ctx.fill();
        }
        ctx.restore(); 

        ctx.beginPath();
        losFloor.forEach((pt, i) => i === 0 ? ctx.moveTo(mapX(pt.x), mapY(pt.hrx)) : ctx.lineTo(mapX(pt.x), mapY(pt.hrx)));
        ctx.strokeStyle = 'rgba(255, 50, 50, 0.8)'; ctx.lineWidth = 1.5; ctx.stroke();

        ctx.beginPath();
        losFloor.forEach((pt, i) => i === 0 ? ctx.moveTo(mapX(pt.x), mapY(pt.htx)) : ctx.lineTo(mapX(pt.x), mapY(pt.htx)));
        ctx.strokeStyle = 'rgba(255, 200, 50, 0.8)'; ctx.lineWidth = 1.5; ctx.stroke();

        ctx.beginPath(); ctx.moveTo(mapX(0), h - padB);
        for(let i=0; i<elevs.length; i++) ctx.lineTo(mapX(i * stepKm), mapY(elevs[i]));
        ctx.lineTo(mapX(d_txrx), h - padB); ctx.closePath();
        ctx.fillStyle = '#1e3050'; ctx.fill(); ctx.strokeStyle = '#2a4a7a'; ctx.lineWidth = 2; ctx.stroke();

        const drawnLabels = []; 

        planeData.forEach(p => {
            const liveEta = p.cr.liveEta, baseColor = scoreColor(p.cr.score);
            const renderColor = Math.abs(liveEta) <= 5 ? '#00ee44' : baseColor;

            ctx.strokeStyle = renderColor + '55'; ctx.lineWidth = 1.0; ctx.setLineDash([3, 4]);
            ctx.beginPath(); ctx.moveTo(mapX(0), mapY(rxAltM)); ctx.lineTo(mapX(p.acX), mapY(p.acAltM)); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(mapX(p.acX), mapY(p.acAltM)); ctx.lineTo(mapX(d_txrx), mapY(txAltM)); ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = renderColor; 
            ctx.beginPath(); ctx.arc(mapX(p.acX), mapY(p.acAltM), 4, 0, Math.PI*2); ctx.fill();
            
            ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '11px sans-serif';
            const labelStr = (p.ac.callsign || p.ac.icao24).toUpperCase() + ' | ' + Math.round(p.acAltM) + 'm';
            let textX = mapX(p.acX);
            
            let textY = mapY(p.acAltM) - 12;
            if (textY < padT + 8) {
                textY = mapY(p.acAltM) + 15;
            }
            
            const textW = ctx.measureText(labelStr).width;
            if (textX - textW/2 < padL) textX = padL + textW/2 + 2;
            if (textX + textW/2 > w - padR) textX = w - padR - textW/2 - 2;
            
            let overlap = true;
            let attempts = 0;
            while(overlap && attempts < 6) {
                overlap = drawnLabels.some(rect => {
                    return Math.abs(textX - rect.x) < (textW/2 + rect.w/2 + 4) && 
                           Math.abs(textY - rect.y) < 14; 
                });
                if (overlap) {
                    textY -= 14; 
                    if (textY < padT + 8) {
                        textY = mapY(p.acAltM) + 15 + (attempts * 14);
                    }
                    attempts++;
                }
            }
            
            if (textY < padT + 6) textY = padT + 6;
            
            drawnLabels.push({x: textX, y: textY, w: textW});
            ctx.fillText(labelStr, textX, textY);
        });

        ctx.strokeStyle = '#668'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(mapX(0), mapY(elevs[0])); ctx.lineTo(mapX(0), mapY(rxAltM)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(mapX(d_txrx), mapY(elevs[elevs.length-1])); ctx.lineTo(mapX(d_txrx), mapY(txAltM)); ctx.stroke();

        ctx.restore(); 

        ctx.fillStyle = '#668'; 
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        const isMetric = S.useMetric;
        const distConv = isMetric ? 1 : 0.621371; 
        const viewDistDisp = (profMaxX - profMinX) * distConv;
        
        let tickStep = 10;
        if (viewDistDisp > 800) tickStep = 200;
        else if (viewDistDisp > 400) tickStep = 100;
        else if (viewDistDisp > 200) tickStep = 50;
        else if (viewDistDisp > 100) tickStep = 25;
        
        const startDisp = Math.ceil((profMinX * distConv) / tickStep) * tickStep;
        const endDisp = Math.floor((profMaxX * distConv) / tickStep) * tickStep;
        const unitStr = isMetric ? ' km' : ' mi';
        
        for (let d = startDisp; d <= endDisp; d += tickStep) {
            const xKm = d / distConv;
            const screenX = mapX(xKm);
            
            if (screenX > padL + 30 && screenX < (w - padR) - 30) {
                ctx.fillText(d + unitStr, screenX, h - padB + 12);
                
                ctx.strokeStyle = '#2a4a7a';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(screenX, h - padB);
                ctx.lineTo(screenX, h - padB + 4);
                ctx.stroke();
            }
        }

        if (profMinX <= 0) { 
            ctx.fillStyle = '#adf'; ctx.textAlign = 'center'; 
            ctx.fillText('RX', mapX(0), h - padB + 12); 
        }
        if (profMaxX >= d_txrx) { 
            ctx.fillStyle = '#adf'; ctx.textAlign = 'center'; 
            ctx.fillText('TX', mapX(d_txrx), h - padB + 12); 
        }
    }

    // ── Map Drawing ──────────────────────────────────────────────────────
    function drawStaticLayers(crossings, rxLat, rxLon){
        if(!mapInstance||!txLayer||!lineLayer) return;
        
        const activeKeys = new Set();

        crossings.forEach(cr=>{
            const {tx,score}=cr;
            const txKey=tx.lat+'_'+tx.lon+'_'+tx.freq;
            const color=scoreColor(score);
            const isHighlighted = (_activeTxKey === txKey) || (_activeProfileTxKey === txKey);

            activeKeys.add(txKey);

            if(!_txElements[txKey]){
                const visualLine = L.polyline([[tx.lat,tx.lon],[rxLat,rxLon]],{ color, weight:isHighlighted?2.5:1.6, opacity:isHighlighted?0.85:0.55, dashArray:'8 5', interactive: false }).addTo(lineLayer);

                const txM=L.marker([tx.lat,tx.lon],{ icon: txDotIcon(color,tx.erp,isHighlighted), zIndexOffset: isHighlighted?200:100 });
                txM.bindTooltip(buildTxTooltip(tx, rxLat, rxLon), {direction: 'top', sticky: true, className: 'as-ac-tooltip-wrap', opacity: 1});
                
                txM.on('click',(e)=>{
                    L.DomEvent.stopPropagation(e);
                    showTxDetails(txKey, tx); 
                });
                txLayer.addLayer(txM);
                
                _txElements[txKey] = { visualLine, txM, baseColor: color, erp: tx.erp, isHighlighted };
            } else {
                const t = _txElements[txKey];
                if(t.baseColor !== color || t.isHighlighted !== isHighlighted) {
                    t.baseColor = color;
                    t.isHighlighted = isHighlighted;
                    t.visualLine.setStyle({color, weight:isHighlighted?2.5:1.6, opacity:isHighlighted?0.85:0.55});
                    t.txM.setIcon(txDotIcon(color, t.erp, isHighlighted));
                    t.txM.setZIndexOffset(isHighlighted?200:100);
                }
            }
        });

        for(let key in _txElements) {
            if(!activeKeys.has(key)) {
                lineLayer.removeLayer(_txElements[key].visualLine);
                txLayer.removeLayer(_txElements[key].txM);
                delete _txElements[key];
            }
        }
    }

    function updateAircraftMarkers(crossings){
        if(!mapInstance||!aircraftLayer) return;
        const activeIcaos=new Set();

        Object.values(_txElements).forEach(t => {
            t.visualLine.setStyle({color: t.baseColor, weight: t.isHighlighted ? 2.5 : 1.6, opacity: t.isHighlighted ? 0.85 : 0.55});
            t.txM.setIcon(txDotIcon(t.baseColor, t.erp, t.isHighlighted));
        });

        crossings.forEach(cr => {
            activeIcaos.add(cr.ac.icao24);
            const ac = cr.ac;
            const liveEta = cr.liveEta;
            
            let drLat=ac.lat, drLon=ac.lon;
            if(ac.track!==null && ac.speed>0) {
                const p = deadReckon(ac.lat, ac.lon, ac.track, ac.speed, cr.elapsed);
                drLat=p.lat; drLon=p.lon;
            }

            const isNow = Math.abs(liveEta) <= 5;
            const renderColor = isNow ? '#00ee44' : scoreColor(cr.score);
            const opacity = liveEta > (S.leadTimeSec/2) ? 0.6 : 1.0;
            
            if (isNow && _txElements[cr.tx.lat+'_'+cr.tx.lon+'_'+cr.tx.freq]) {
                const t = _txElements[cr.tx.lat+'_'+cr.tx.lon+'_'+cr.tx.freq];
                t.visualLine.setStyle({color: '#00ee44', weight: 2.5, opacity: 0.85});
                t.txM.setIcon(txDotIcon('#00ee44', t.erp, t.isHighlighted));
            }

            const ttHtml = `
                <div class="as-ac-tooltip">
                    <b>✈ ${ac.callsign||ac.icao24}</b><br>
                    Alt: ${fmtAlt(ac.alt_ft)}<br>
                    Spd: ${fmtSpeed(ac.speed)} | Trk: ${ac.track?Math.round(ac.track)+'°':'—'}<br>
                    VSpd: ${fmtVspeed(ac.vspeed)}<br>
                    <div style="margin-top:4px;border-top:1px solid #4aaeff;padding-top:4px;">
                        <b>Active target:</b><br>
                        ${cr.tx.city} (${cr.tx.itu})<br>
                        Score: ${cr.score}% | ETA: ${fmtEta(liveEta)}
                    </div>
                </div>`;

            if(_drMarkers[ac.icao24]){
                _drMarkers[ac.icao24].marker.setLatLng([drLat,drLon]);
                _drMarkers[ac.icao24].marker.setIcon(planeIcon(ac.track,renderColor,opacity,ac.category));
                _drMarkers[ac.icao24].marker.setTooltipContent(ttHtml);
                
                _drMarkers[ac.icao24].label.setLatLng([drLat,drLon]);
                const span=_drMarkers[ac.icao24].label._icon?.querySelector('span');
                if(span){ span.textContent=fmtEta(liveEta); span.className='as-countdown-cell '+etaClass(liveEta); span.parentElement.style.opacity=opacity; }
            } else {
                const acM=L.marker([drLat,drLon],{icon:planeIcon(ac.track,renderColor,opacity,ac.category),zIndexOffset:500});
                acM.bindTooltip(ttHtml, {direction: 'top', sticky: true, className: 'as-ac-tooltip-wrap', opacity: 1});
                
                const lblM=L.marker([drLat,drLon],{
                    icon:L.divIcon({
                        html:`<div style="opacity:${opacity}"><span class="as-countdown-cell ${etaClass(liveEta)}" 
                            style="font-size:10px;background:rgba(0,0,0,0.65);color:#fff;padding:1px 4px;border-radius:3px;white-space:nowrap;">${fmtEta(liveEta)}</span></div>`,
                        className:'',iconSize:null,iconAnchor:[-14,6]
                    }),interactive:false
                });
                aircraftLayer.addLayer(acM); aircraftLayer.addLayer(lblM);
                _drMarkers[ac.icao24]={marker:acM,label:lblM};
            }
        });

        Object.keys(_drMarkers).forEach(icao=>{
            if(!activeIcaos.has(icao)){
                aircraftLayer.removeLayer(_drMarkers[icao].marker);
                aircraftLayer.removeLayer(_drMarkers[icao].label);
                delete _drMarkers[icao];
            }
        });
    }

    // ── Left Panel UI ─────────────────────────────────────────────────────
    function updateListPanel(crossings){
        const body = document.getElementById('as-list-body');
        if(!body || document.getElementById('as-tx-detail-panel').style.display === 'flex') return;

        const sortedAc = [...crossings].sort((a,b) => Math.abs(a.liveEta) - Math.abs(b.liveEta));

        if(!sortedAc.length){
            const empty = '<div style="padding:10px;color:#446;font-size:11px;">No active candidates</div>';
            if(body.innerHTML !== empty) body.innerHTML = empty;
            return;
        }

        // Build a map of what's currently rendered
        const existingItems = {};
        body.querySelectorAll('.as-list-item[data-tx-key]').forEach(el => {
            const k = el.dataset.txKey + '|' + (el.dataset.icao || '');
            existingItems[k] = el;
        });

        const newKeys = new Set();
        sortedAc.forEach((cr, idx) => {
            const tKey = cr.tx.lat+'_'+cr.tx.lon+'_'+cr.tx.freq;
            const icao = cr.ac.icao24;
            const mapKey = tKey + '|' + icao;
            newKeys.add(mapKey);

            const approaching = cr.liveEta > (S.leadTimeSec/2) ? 'as-list-approaching' : '';
            const etaClass_ = etaClass(cr.liveEta);
            const scoreColorVal = scoreColor(cr.score);

            if(existingItems[mapKey]) {
                // Surgical update: only ETA and score
                const el = existingItems[mapKey];
                el.className = 'as-list-item ' + approaching;

                const scoreEl = el.querySelector('.as-li-score');
                if(scoreEl) { scoreEl.textContent = cr.score + '%'; scoreEl.style.color = scoreColorVal; }

                const etaEl = el.querySelector('.as-li-eta');
                if(etaEl) { etaEl.textContent = fmtEta(cr.liveEta); etaEl.className = 'as-li-eta ' + etaClass_; }

                // Ensure correct position
                const children = [...body.children];
                if(children.indexOf(el) !== idx) {
                    body.insertBefore(el, body.children[idx] || null);
                }
            } else {
                // New item — build full HTML including flag (only once per item)
                const flagHtml = getFlagImg(cr.tx.itu, 16, 12);
                const prefix = flagHtml ? flagHtml + ' ' : '→ ';

                const el = document.createElement('div');
                el.className = 'as-list-item ' + approaching;
                el.dataset.txKey = tKey;
                el.dataset.icao = icao;
                el.innerHTML = `
                    <div class="as-li-top">
                        <span class="as-li-ac">✈ ${cr.ac.callsign||cr.ac.icao24}</span>
                        <span class="as-li-score" style="color:${scoreColorVal}">${cr.score}%</span>
                    </div>
                    <div class="as-li-top" style="margin-top:2px;">
                        <span class="as-li-tx">${prefix}${cr.tx.city} [${cr.tx.itu}]</span>
                        <span class="as-li-eta ${etaClass_}">${fmtEta(cr.liveEta)}</span>
                    </div>`;
                el.addEventListener('click', () => {
                    const txObj = Object.values(_persistentCrossings).flatMap(m=>Object.values(m)).find(c=>(c.tx.lat+'_'+c.tx.lon+'_'+c.tx.freq)===tKey)?.tx;
                    if(txObj) showTxDetails(tKey, txObj);
                });

                body.insertBefore(el, body.children[idx] || null);
            }
        });

        // Remove stale items
        Object.entries(existingItems).forEach(([k, el]) => {
            if(!newKeys.has(k)) el.remove();
        });
    }

    async function showTxDetails(txKey, tx) {
        document.getElementById('as-list-header').style.display = 'none';
        document.getElementById('as-list-body').style.display = 'none';
        
        const dp = document.getElementById('as-tx-detail-panel');
        dp.style.display = 'flex';
        renderTxDetailsContent(txKey, tx);

        const rx = getRxCoords();
        if(rx) {
            _activeProfileTxKey = txKey; 
            _activeProfileTxObj = tx;
            profMinX = 0; 
            profMaxX = 0; 
            document.getElementById('as-profile-panel').style.display = 'flex';
            resizeProfileCanvas(); 
        }

        setTxFilter(txKey);

        if(rx && mapInstance) {
            mapInstance.invalidateSize();
            
            const bounds = L.latLngBounds([[rx.lat, rx.lon], [tx.lat, tx.lon]]);
            const allCrs = getActiveVisibleCrossings().filter(c => (c.tx.lat+'_'+c.tx.lon+'_'+c.tx.freq) === txKey);
            
            allCrs.forEach(cr => {
                let drLat = cr.ac.lat, drLon = cr.ac.lon;
                if(cr.ac.track !== null && cr.ac.speed > 0) {
                    const p = deadReckon(cr.ac.lat, cr.ac.lon, cr.ac.track, cr.ac.speed, cr.elapsed);
                    drLat = p.lat; drLon = p.lon;
                }
                bounds.extend([drLat, drLon]);
            });

            setTimeout(() => {
                mapInstance.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
            }, 50);

            _currentPathElevs = await fetchPathElevation(rx.lat, rx.lon, tx.lat, tx.lon, txKey);
            redrawActiveProfile();
        }
    }

    function hideTxDetails() {
        document.getElementById('as-tx-detail-panel').style.display = 'none';
        document.getElementById('as-list-header').style.display = 'flex';
        document.getElementById('as-list-body').style.display = 'block';

        document.getElementById('as-profile-panel').style.display = 'none';
        
        _activeProfileTxKey = null; _activeProfileTxObj = null;

        _activeTxKey = null; 
        updateCompassUI();
        
        if(mapInstance) mapInstance.invalidateSize();
        redrawFiltered();
    }

    function renderTxDetailsContent(txKey, tx) {
        const bd = document.getElementById('as-tx-detail-body');
        if(!bd) return;

        const rx = getRxCoords();
        const allCrs = getActiveVisibleCrossings().filter(c => (c.tx.lat+'_'+c.tx.lon+'_'+c.tx.freq) === txKey);
        allCrs.sort((a,b) => Math.abs(a.liveEta) - Math.abs(b.liveEta));

        if (!bd.dataset.txKey || bd.dataset.txKey !== txKey) {
            bd.dataset.txKey = txKey;

            const siblings = txSiblings(tx);
            const progsRows = siblings.map(t => {
                const progName = t.station || t.ps || '?';
                const tuneCmd = `T${Math.round(t.freq * 1000)}`;
                return `
                <tr>
                    <td style="color:#4aaeff; white-space:nowrap; cursor:pointer;"
                        title="Click to tune"
                        onmouseover="this.style.textDecoration='underline'; this.style.color='#fff';"
                        onmouseout="this.style.textDecoration='none'; this.style.color='#4aaeff';"
                        onclick="if(typeof socket !== 'undefined' && socket.readyState === 1) { socket.send('${tuneCmd}'); } else { alert('WebSocket is not connected'); }">
                        ${t.freq.toFixed(2)} MHz
                    </td>
                    <td style="color:#fff; width:100%; max-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${progName}">${progName}</td>
                    <td style="color:#889; text-align:center; padding:0 8px;">${t.pol||'—'}</td>
                    <td style="color:#cde; text-align:right; white-space:nowrap;">${t.erp} kW</td>
                </tr>`;
            }).join('');

            const flagHtml = getFlagImg(tx.itu, 20, 15);
            
            // Calculate azimuth and format HTML
            let azHtml = '—';
            if (rx) {
                const az = Math.round(bearingDeg(rx.lat, rx.lon, tx.lat, tx.lon));
                const canTurnRotor = (isAdminLoggedIn || isTuneLoggedIn) && lastRotorAzimuth !== null;
                
                if (canTurnRotor) {
                    azHtml = `<span style="color:#4aaeff; cursor:pointer;" 
                                    title="Click to turn Rotor to ${az}°"
                                    onmouseover="this.style.textDecoration='underline'; this.style.color='#fff';"
                                    onmouseout="this.style.textDecoration='none'; this.style.color='#4aaeff';"
                                    onclick="if(window._asSendRotorPosition) window._asSendRotorPosition(${az});">
                              ${az}°
                              </span>`;
                } else {
                    azHtml = `${az}°`;
                }
            }

            bd.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <div style="font-size:13px; font-weight:bold; color:#fff;">${tx.city} [${tx.itu}]</div>
                    ${flagHtml ? `<div>${flagHtml}</div>` : ''}
                </div>
                <table class="tx-info-table">
                    <tr><td>Distance</td><td>${tx.dist} km</td></tr>
                    <tr><td>Azimuth</td><td>${azHtml}</td></tr>
                    <tr><td>Terrain</td><td>${tx.terrainM||0} m</td></tr>
                </table>
                <div style="margin-bottom:10px; background:#162032; padding:4px 6px; border-radius:4px;">
                    <table class="tx-freq-table">${progsRows}</table>
                </div>
                <div style="color:#889; font-size:11px; margin-bottom:4px; border-bottom:1px solid #2a4a7a; padding-bottom:2px;">Crossing Aircraft</div>
                <div id="as-tx-ac-list"></div>
            `;
        }

        const acListEl = document.getElementById('as-tx-ac-list');
        if (!acListEl) return;

        if (allCrs.length === 0) {
            const empty = '<div style="color:#668;font-size:11px;">No aircraft in window.</div>';
            if (acListEl.innerHTML !== empty) acListEl.innerHTML = empty;
            return;
        }

        const activeIcaos = new Set(allCrs.map(c => c.ac.icao24));

        acListEl.querySelectorAll('[data-icao]').forEach(el => {
            if (!activeIcaos.has(el.dataset.icao)) el.remove();
        });

        allCrs.forEach((c, idx) => {
            const icao = c.ac.icao24;
            let row = acListEl.querySelector(`[data-icao="${icao}"]`);
            const etaHtml = `<span style="color:${scoreColor(c.score)}; margin-right:6px; font-weight:bold;">${c.score}%</span><span class="as-countdown-cell ${etaClass(c.liveEta)}">${fmtEta(c.liveEta)}</span>`;
            const nameHtml = `✈ ${c.ac.callsign || c.ac.icao24}`;

            if (!row) {
                row = document.createElement('div');
                row.className = 'tx-ac-row';
                row.dataset.icao = icao;
                row.innerHTML = `<span style="color:#fff;">${nameHtml}</span><span class="as-tx-eta-cell">${etaHtml}</span>`;

                const rows = acListEl.querySelectorAll('[data-icao]');
                if (idx < rows.length) acListEl.insertBefore(row, rows[idx]);
                else acListEl.appendChild(row);
            } else {
                const etaCell = row.querySelector('.as-tx-eta-cell');
                if (etaCell) etaCell.innerHTML = etaHtml;
            }
        });
    }

    function redrawFiltered() {
        const rx = getRxCoords(); if(!rx) return;
        const allVisible = getActiveVisibleCrossings();
        allVisible.sort((a,b) => a.score - b.score); 
        const primaryVisible = getPrimaryCrossings(allVisible);
        
        drawStaticLayers(allVisible, rx.lat, rx.lon);
        updateAircraftMarkers(primaryVisible);
        updateListPanel(primaryVisible);
        
        if(_activeTxKey && document.getElementById('as-tx-detail-panel').style.display === 'flex') {
            const txObj = Object.values(_persistentCrossings).flatMap(m=>Object.values(m)).find(c=>(c.tx.lat+'_'+c.tx.lon+'_'+c.tx.freq)===_activeTxKey)?.tx;
            if(txObj) renderTxDetailsContent(_activeTxKey, txObj);
        }
        
        if(_activeProfileTxKey && document.getElementById('as-profile-panel').style.display === 'flex') {
            redrawActiveProfile(); 
        }

        const infoEl = document.getElementById('as-header-info');
        if (infoEl) {
            if (_activeTxKey) {
                infoEl.style.display = 'block';
                infoEl.textContent = '1 station selected (click to clear)';
            } else if ((_activeCompass && _activeCompass.length > 0) || _activeFreq || (isCompassLocked && lastRotorAzimuth !== null)) {
                infoEl.style.display = 'block';
                let txt = [];
                if (_activeCompass && _activeCompass.length > 0) txt.push(`${_activeCompass.join(' & ')}`);
                if (_activeFreq) txt.push(`${_activeFreq.toFixed(2)} MHz`);
                if (isCompassLocked && lastRotorAzimuth !== null) txt.push(`Rotor: ${lastRotorAzimuth}°`);
                infoEl.textContent = `Filtered by ${txt.join(' | ')} (click to clear)`;
            } else {
                infoEl.style.display = 'none';
            }
            
            infoEl.onclick = () => {
                if (_activeTxKey) {
                    // Case 1: Station is selected -> Only close station
                    hideTxDetails(); 
                } else {
                    // Case 2: No station selected -> Remove all filters and locks
                    isCompassLocked = false;
                    _activeCompass = null;
                    const compassLockBtn = document.getElementById('as-compass-lock');
                    if (compassLockBtn) {
                        compassLockBtn.textContent = '🔓';
                        compassLockBtn.classList.remove('locked');
                        compassLockBtn.title = "Lock Compass to Rotor";
                    }

                    isFreqLocked = false;
                    _activeFreq = null;
                    const freqInp = document.getElementById('as-freq-input');
                    if (freqInp) {
                        freqInp.disabled = false;
                        freqInp.value = '';
                    }
                    const freqLockBtn = document.getElementById('as-freq-lock');
                    if (freqLockBtn) {
                        freqLockBtn.textContent = '🔓';
                        freqLockBtn.classList.remove('locked');
                        freqLockBtn.title = "Lock Frequency to Radio";
                    }

                    updateCompassUI();
                    redrawFiltered();
                }
            };
        }
    }

    // ── Main WebSocket ────────────────────────────────────────────────────
    async function setupMainWebSocket() {
        if (!mainWebsocket || mainWebsocket.readyState === WebSocket.CLOSED) {
            try {
                if (typeof window.socketPromise !== 'undefined') {
                    mainWebsocket = await window.socketPromise;
                    if (mainWebsocket.readyState === WebSocket.OPEN) {
                        debugLog("Main WebSocket already connected.");
                    } else {
                        mainWebsocket.addEventListener("open", () => {
                            debugLog("Main WebSocket connected.");
                        });
                    }
                    mainWebsocket.addEventListener("error", (error) => {
                        debugLog("Main WebSocket error:", error);
                    });
                    mainWebsocket.addEventListener("close", (event) => {
                        debugLog("Main WebSocket connection closed, retrying in 5 seconds.");
                        setTimeout(setupMainWebSocket, 5000);
                    });
                } else {
                    debugLog("window.socketPromise is undefined.");
                }
            } catch (error) {
                debugLog("Error during Main WebSocket setup:", error);
            }
        }
    }

    // Radio text/status WS to fetch current frequency automatically
    function setupRdsWebSocket() {
        if (rdsWebsocket && rdsWebsocket.readyState !== WebSocket.CLOSED) return;
        try {
            rdsWebsocket = new WebSocket(TEXT_WS_URL);
            rdsWebsocket.addEventListener('message', evt => {
                if (!isFreqLocked) return;
                try {
                    const data = JSON.parse(evt.data);
                    let newFreq = null;
                    if (data.freq !== undefined) newFreq = parseFloat(data.freq);
                    else if (data.frequency !== undefined) newFreq = parseFloat(data.frequency);
                    else if (data.status && data.status.freq !== undefined) newFreq = parseFloat(data.status.freq);
                    
                    if (newFreq !== null) {
                        if (newFreq > 8700) newFreq = newFreq / 100;
                        else if (newFreq >= 870 && newFreq <= 1080) newFreq = newFreq / 10;
                        
                        const freqInp = document.getElementById('as-freq-input');
                        if (freqInp && freqInp.value !== newFreq.toFixed(2)) {
                            freqInp.value = newFreq.toFixed(2);
                            _activeFreq = newFreq;
                            redrawFiltered();
                        }
                    }
                } catch(e) {}
            });
            rdsWebsocket.addEventListener('close', () => setTimeout(setupRdsWebSocket, 5000));
        } catch (e) {
            debugLog("Error during RDS WebSocket setup:", e);
        }
    }

    // ── Settings UI ───────────────────────────────────────────────────────
    function buildSettingsPanelHtml(){
        return `<div id="as-settings-panel">
            <h5>
                ⚙ Airplane Scatter Settings
                <button id="as-settings-close" class="as-sub-close">✕</button>
            </h5>
            <div class="as-setting-row"><label>Min TX–RX distance</label>
                <input type="number" id="as-s-txrx" min="50" max="800" step="10" value="${S.minTxRxDistKm}">
                <span class="as-setting-unit">km</span></div>
            <div class="as-setting-row"><label>Min TX ERP</label>
                <input type="number" id="as-s-erp" min="1" max="1000" step="1" value="${S.minTxErpKw}">
                <span class="as-setting-unit">kW</span></div>
            <div class="as-setting-row"><label>Lead time (Visible from)</label>
                <input type="text" id="as-s-lead" placeholder="mm:ss" value="${formatTimeStr(S.leadTimeSec)}">
                <span class="as-setting-unit">mm:ss</span></div>
            <div class="as-setting-row"><label>Trail time (Visible until)</label>
                <input type="text" id="as-s-trail" placeholder="mm:ss" value="${formatTimeStr(S.trailTimeSec)}">
                <span class="as-setting-unit">mm:ss</span></div>
            <div class="as-setting-row"><label>Fetch radius (TX & Aircraft)</label>
                <input type="number" id="as-s-maxrad" min="100" max="1500" step="50" value="${S.txRadiusKm}">
                <span class="as-setting-unit">km</span></div>
            <div class="as-setting-row"><label>Min scatter score (peak)</label>
                <input type="number" id="as-s-score" min="1" max="99" step="1" value="${S.minScore}">
                <span class="as-setting-unit">%</span></div>
            
            <div style="border-top:1px solid #2a4a7a;margin:8px 0 6px;"></div>
            
            <div class="as-setting-row">
                <label style="color:#fff;">Use Metric System</label>
                <input type="checkbox" id="as-s-metric" ${S.useMetric ? 'checked' : ''} style="width:auto; cursor:pointer;">
            </div>

            <div style="border-top:1px solid #2a4a7a;margin:8px 0 6px;"></div>

            <div class="as-setting-info">RX terrain: <b id="as-rx-terrain-val">${Math.round(_rxTerrainM)}</b> m</div>
            <div class="as-setting-row"><label>RX antenna height (AGL)</label>
                <input type="number" id="as-s-rxagl" min="1" max="500" step="1" value="${S.rxAglM}">
                <span class="as-setting-unit">m</span></div>
            <button id="as-settings-apply">✔ Apply &amp; Reload</button>
            <button id="as-settings-reset">↺ Reset to defaults</button>
        </div>`;
    }

    function initSettingsPanel(){
        const btn=document.getElementById('as-settings-btn'), panel=document.getElementById('as-settings-panel');
        if(!btn||!panel) return;
        
        btn.addEventListener('click', e => { e.stopPropagation(); panel.style.display = panel.style.display !== 'none' ? 'none' : 'block'; });
        document.getElementById('as-settings-close').onclick = () => panel.style.display = 'none';
        document.addEventListener('click', e => { if(!panel.contains(e.target) && e.target !== btn) panel.style.display = 'none'; });

        document.getElementById('as-settings-apply').addEventListener('click', () => {
            const v = id => document.getElementById(id).value;
            const isM = document.getElementById('as-s-metric').checked;
            
            localStorage.setItem('as_use_metric', isM);
            localStorage.setItem('as_min_txrx_dist', v('as-s-txrx'));
            localStorage.setItem('as_min_erp', v('as-s-erp'));
            localStorage.setItem('as_lead_time_str', v('as-s-lead'));
            localStorage.setItem('as_trail_time_str', v('as-s-trail'));
            
            const maxRad = v('as-s-maxrad');
            localStorage.setItem('as_tx_radius', maxRad);
            localStorage.setItem('as_ac_radius', maxRad);
            
            localStorage.setItem('as_min_score', v('as-s-score'));
            localStorage.setItem('as_rx_agl', v('as-s-rxagl'));

            S = loadSettings(); _rxElevM = _rxTerrainM + S.rxAglM;
            panel.style.display = 'none';
            _persistentCrossings = {}; 
            startUpdate(false);
        });
        
        document.getElementById('as-settings-reset').addEventListener('click', () => {
            document.getElementById('as-s-metric').checked = true;
            document.getElementById('as-s-txrx').value = 400;
            document.getElementById('as-s-erp').value = 100;
            document.getElementById('as-s-lead').value = '03:00';
            document.getElementById('as-s-trail').value = '01:00';
            document.getElementById('as-s-maxrad').value = 750;
            document.getElementById('as-s-score').value = 75;
            document.getElementById('as-s-rxagl').value = RX_AGL_DEFAULT_M;
        });
    }

    // ── Main UI Layout ───────────────────────────────────────────────────
    function createMapContainer(rxLat,rxLon){
        if(mapContainer) return;
        
        // Read again when opening!
        let startLeft   = parseInt(localStorage.getItem('as_left'))   || 240;
        let startTop    = parseInt(localStorage.getItem('as_top'))    || 20;
        let startWidth  = parseInt(localStorage.getItem('as_width'))  || 820;
        let startHeight = parseInt(localStorage.getItem('as_height')) || 640;

        // Bounds check so it doesn't pop up offscreen
        if (startLeft < 0) startLeft = 0;
        if (startTop < 0) startTop = 0;
        if (startLeft > window.innerWidth - 100) startLeft = window.innerWidth - 300;
        if (startTop > window.innerHeight - 100) startTop = 20;

        const wrapper = document.createElement('div');
        wrapper.id = 'as-wrapper';
        wrapper.style.cssText = `left:${startLeft}px;top:${startTop}px;width:${startWidth+250}px;height:${startHeight}px;`;

        const listPanel = document.createElement('div');
        listPanel.id = 'as-list-panel';
        listPanel.innerHTML = `
            <div id="as-list-header"><span>📡 Scatter Candidates</span></div>
            <div id="as-list-body"><div style="padding:10px;color:#446;">Loading…</div></div>
            
            <div id="as-tx-detail-panel">
                <div class="as-sub-header">
                    <div class="as-sub-title">📡 Transmitter Details</div>
                    <button id="as-tx-detail-close" class="as-sub-close">✕</button>
                </div>
                <div id="as-tx-detail-body"></div>
            </div>
        `;
        wrapper.appendChild(listPanel);

        mapContainer = document.createElement('div');
        mapContainer.id = 'as-container';
        mapContainer.style.width = startWidth + 'px';
        
        // Check if we need to show the lock or the X
        const showLock = lastRotorAzimuth !== null;
        const lockIcon = isCompassLocked ? '🔒' : '🔓';
        const lockTitle = isCompassLocked ? 'Unlock Compass' : 'Lock Compass to Rotor';
        const lockClass = isCompassLocked ? 'locked' : '';

        mapContainer.innerHTML = `
            <div id="as-header">
                <div class="as-title"><i class="fas fa-plane"></i><span> Airplane Scatter</span></div>
                <div id="as-header-info" style="color:#4aaeff; font-size:12px; font-weight:bold; cursor:pointer; display:none; flex:1; text-align:center;">1 station selected (click to clear)</div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <a id="as-help-btn" href="https://highpoint.fmdx.org/manuals/AirplaneScatter-Documentation.html" target="_blank" title="Documentation" style="color:#adf;font-size:15px;padding:0 6px;line-height:1;text-decoration:none;display:flex;align-items:center;">&#63;</a>
                    <button id="as-settings-btn" title="Settings">&#9881;</button>
                    <button id="as-reload" title="Reload">&#8635;</button>
                    <button id="as-close" title="Close">&#x2715;</button>
                </div>
            </div>
            
            <div id="as-map">
                <div id="as-leaflet-wrap"></div>

                <div id="as-compass" class="leaflet-control">
                    <button class="as-comp-btn" data-dir="NW">NW</button>
                    <button class="as-comp-btn" data-dir="N">N</button>
                    <button class="as-comp-btn" data-dir="NO">NO</button>
                    <button class="as-comp-btn" data-dir="W">W</button>
                    <button class="as-comp-btn as-comp-center" id="as-compass-clear" data-dir="ALL" style="display:${showLock ? 'none' : 'flex'};">✕</button>
                    <button class="as-comp-btn as-comp-center ${lockClass}" id="as-compass-lock" title="${lockTitle}" style="display:${showLock ? 'flex' : 'none'};">${lockIcon}</button>
                    <button class="as-comp-btn" data-dir="O">O</button>
                    <button class="as-comp-btn" data-dir="SW">SW</button>
                    <button class="as-comp-btn" data-dir="S">S</button>
                    <button class="as-comp-btn" data-dir="SO">SO</button>
                </div>

                <div id="as-freq-filter" class="leaflet-control">
                    <input type="text" id="as-freq-input" placeholder="MHz">
                    <button id="as-freq-lock" title="Lock Frequency to Radio">🔓</button>
                </div>

                <div id="as-profile-panel">
                    <div class="as-sub-header">
                        <div class="as-sub-title">⛰️ Elevation Profile</div>
                        <button id="as-profile-close" class="as-sub-close">✕</button>
                    </div>
                    <div style="position:relative; flex:1; width:100%; display:flex;">
                        <canvas id="as-profile-canvas"></canvas>
                        <div id="as-profile-y-zoom-container" title="Vertical Zoom (Double-click to reset)">
                            <input type="range" id="as-profile-y-zoom" min="0.2" max="4.0" step="0.1" value="1.0">
                        </div>
                    </div>
                </div>
            </div>

            <div id="as-statusbar">
                <span id="as-stat-ac">✈ —</span>
                <span id="as-stat-cand">📡 —</span>
                <span id="as-stat-db">DB: —</span>
                <span id="as-stat-msg" style="margin-left:auto; font-weight:bold;"></span>
            </div>
            <div id="as-resizer"></div>`;
        wrapper.appendChild(mapContainer);
        document.body.appendChild(wrapper);
        wrapper.classList.add('as-fade-in');

        mapContainer.insertAdjacentHTML('beforeend', buildSettingsPanelHtml());
        addDrag(wrapper, document.getElementById('as-header'));
        addResize(wrapper);
        initSettingsPanel();
        initProfileCanvasEvents();

        document.getElementById('as-close').onclick = closeMap;
        document.getElementById('as-tx-detail-close').onclick = hideTxDetails;
        document.getElementById('as-profile-close').onclick = hideTxDetails; 

        document.getElementById('as-reload').onclick = () => {
            localStorage.removeItem(DB_CACHE_KEY); localStorage.removeItem(DB_CACHE_TS); localStorage.removeItem(DB_CACHE_LOC); startUpdate(true);
        };

        const freqInp = document.getElementById('as-freq-input');
        if (freqInp) {
            freqInp.addEventListener('input', (e) => {
                _activeFreq = parseFreq(e.target.value);
                redrawFiltered();
                
                if (_activeFreq !== null && typeof socket !== 'undefined' && socket.readyState === 1) {
                    socket.send('T' + Math.round(_activeFreq * 1000));
                }
            });
        }
        
        const freqLock = document.getElementById('as-freq-lock');
        if (freqLock) {
            freqLock.addEventListener('click', () => {
                isFreqLocked = !isFreqLocked;
                if (isFreqLocked) {
                    freqLock.textContent = '🔒';
                    freqLock.classList.add('locked');
                    freqLock.title = "Unlock Frequency";
                    if (freqInp) freqInp.disabled = true;
                } else {
                    freqLock.textContent = '🔓';
                    freqLock.classList.remove('locked');
                    freqLock.title = "Lock Frequency to Radio";
                    if (freqInp) {
                        freqInp.disabled = false;
                        freqInp.value = '';
                    }
                    _activeFreq = null;
                    redrawFiltered();
                }
            });
        }

        ensureLeaflet(()=>{
            if (freqLock) {
                freqLock.addEventListener('mousedown', L.DomEvent.stopPropagation);
                freqLock.addEventListener('dblclick', L.DomEvent.stopPropagation);
            }

            const compassClearBtn = document.getElementById('as-compass-clear');
            if (compassClearBtn) {
                compassClearBtn.addEventListener('click', (e) => {
                    L.DomEvent.stopPropagation(e);
                    _activeCompass = null; 
                    _activeTxKey = null; 
                    updateCompassUI(); redrawFiltered();
                });
                compassClearBtn.addEventListener('mousedown', L.DomEvent.stopPropagation);
                compassClearBtn.addEventListener('dblclick', L.DomEvent.stopPropagation);
            }

            const compassLockBtn = document.getElementById('as-compass-lock');
            if (compassLockBtn) {
                compassLockBtn.addEventListener('click', (e) => {
                    L.DomEvent.stopPropagation(e);
                    isCompassLocked = !isCompassLocked;
                    if (isCompassLocked) {
                        compassLockBtn.textContent = '🔒';
                        compassLockBtn.classList.add('locked');
                        compassLockBtn.title = "Unlock Compass";
                        updateCompassFromRotor();
                    } else {
                        compassLockBtn.textContent = '🔓';
                        compassLockBtn.classList.remove('locked');
                        compassLockBtn.title = "Lock Compass to Rotor";
                    }
                    updateCompassUI();
                    redrawFiltered();
                });
                compassLockBtn.addEventListener('mousedown', L.DomEvent.stopPropagation);
                compassLockBtn.addEventListener('dblclick', L.DomEvent.stopPropagation);
            }

            // Adjust the event for the compass buttons in ensureLeaflet from createMapContainer():
            document.querySelectorAll('.as-comp-btn:not(.as-comp-center)').forEach(b => {
                b.addEventListener('click', (e) => {
                    L.DomEvent.stopPropagation(e);
                    if (isCompassLocked) return; // If locked to rotor, block manual input
                    
                    const dir = e.target.dataset.dir;
                    
                    // If no direction is active yet, start a new array
                    if (!_activeCompass) {
                        _activeCompass = [dir];
                    } else {
                        // If the direction is already in the array, remove it
                        if (_activeCompass.includes(dir)) {
                            _activeCompass = _activeCompass.filter(d => d !== dir);
                            // If no direction is left, set the filter to null (deactivated)
                            if (_activeCompass.length === 0) {
                                _activeCompass = null;
                            }
                        } else {
                            // If the direction is not yet in the array, add it
                            _activeCompass.push(dir);
                        }
                    }
                    
                    _activeTxKey = null; 
                    updateCompassUI(); 
                    redrawFiltered();
                });
                b.addEventListener('mousedown', L.DomEvent.stopPropagation);
                b.addEventListener('dblclick', L.DomEvent.stopPropagation);
            });

            if (freqInp) {
                freqInp.addEventListener('mousedown', L.DomEvent.stopPropagation);
                freqInp.addEventListener('dblclick', L.DomEvent.stopPropagation);
            }

            const mapDiv = document.getElementById('as-leaflet-wrap');
            mapInstance = L.map(mapDiv, {zoomControl:true}).setView([rxLat, rxLon], 6);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'Leaflet | &copy; OpenStreetMap', maxZoom:13 }).addTo(mapInstance);
            
            lineLayer     = L.layerGroup().addTo(mapInstance);
            txLayer       = L.layerGroup().addTo(mapInstance);
            aircraftLayer = L.layerGroup().addTo(mapInstance);

            const rxIcon = L.divIcon({ html: `<div style="width:16px;height:16px;border-radius:50%;background:#2196F3;border:3px solid #0b5ed7;"></div>`, className: '', iconSize: [16,16], iconAnchor: [8,8] });
            rxMarker = L.marker([rxLat, rxLon], {icon: rxIcon, zIndexOffset: 2000}).addTo(mapInstance);

            mapInstance.on('click', () => { 
                if(_activeTxKey) hideTxDetails();
            });

            setTimeout(() => mapInstance.invalidateSize(), 200);
        });
    }

    function setTxFilter(txKey) {
        _activeTxKey = txKey; 

    }

    function updateCompassUI() {
        document.querySelectorAll('.as-comp-btn:not(.as-comp-center)').forEach(b => {
            if(_activeCompass && _activeCompass.includes(b.dataset.dir)) b.classList.add('active');
            else b.classList.remove('active');
            
            if (isCompassLocked) {
                b.style.opacity = '0.5';
                b.style.cursor = 'not-allowed';
            } else {
                b.style.opacity = '1';
                b.style.cursor = 'pointer';
            }
        });
    }

    function closeMap() {
        mapActive=false;
        if(aircraftTimer){clearInterval(aircraftTimer);aircraftTimer=null;}
        if(countdownTimer){clearInterval(countdownTimer);countdownTimer=null;}
        const btn=document.getElementById('AIRPLANESCATTER-on-off'); if(btn) btn.classList.remove('active');
        const wrapper=document.getElementById('as-wrapper');
        if(wrapper){ 
            wrapper.classList.remove('as-fade-in'); 
            wrapper.classList.add('as-fade-out'); 
            wrapper.addEventListener('animationend', () => {
                wrapper.remove();
                if (mapInstance) { mapInstance.remove(); mapInstance = null; }
                mapContainer = null;
                txLayer = null;
                aircraftLayer = null;
                lineLayer = null;
                rxMarker = null;
                _txElements = {};
                _drMarkers = {};
                _activeCompass = null;
                _activeFreq = null;
                _activeTxKey = null;
                isFreqLocked = false;
                isCompassLocked = false;
            }); 
        }
    }

    function addDrag(el, handle){
        let ox, oy, sl, st;
        handle.onmousedown = e => {
            if(e.target.closest('button') || e.target.closest('input') || e.target.closest('#as-header-info') || e.target.closest('#as-help-btn')) return;
            e.preventDefault(); ox=e.clientX; oy=e.clientY; sl=el.offsetLeft; st=el.offsetTop;
            document.onmousemove = me => { el.style.left = Math.max(0, Math.min(sl+me.clientX-ox, window.innerWidth-el.offsetWidth)) + 'px'; el.style.top  = Math.max(0, Math.min(st+me.clientY-oy, window.innerHeight-el.offsetHeight)) + 'px'; };
            document.onmouseup = () => { localStorage.setItem('as_left', el.offsetLeft); localStorage.setItem('as_top', el.offsetTop); document.onmousemove = document.onmouseup = null; };
        };
    }

    function addResize(wrapper){
        const resizer = document.getElementById('as-resizer');
        if(!resizer) return;
        resizer.addEventListener('mousedown', e => {
            e.preventDefault(); const sx = e.clientX, sy = e.clientY, sw = mapContainer.offsetWidth, sh = wrapper.offsetHeight;
            document.onmousemove = me => {
                const nw = Math.max(400, sw + me.clientX - sx), nh = Math.max(400, sh + me.clientY - sy);
                wrapper.style.width = (nw + 250) + 'px'; mapContainer.style.width = nw + 'px'; wrapper.style.height = nh + 'px';
                document.getElementById('as-list-panel').style.height = nh + 'px';
                if(mapInstance) mapInstance.invalidateSize();
                resizeProfileCanvas(); redrawActiveProfile();
            };
            document.onmouseup = () => { localStorage.setItem('as_width', mapContainer.offsetWidth); localStorage.setItem('as_height', wrapper.offsetHeight); document.onmousemove = document.onmouseup = null; };
        });
    }

    function getRxCoords(){
        if(gpsLat&&gpsLon&&!isNaN(gpsLat)&&gpsLat!==0) return {lat:gpsLat,lon:gpsLon};
        const lat=parseFloat(localStorage.getItem('qthLatitude')||'0'), lon=parseFloat(localStorage.getItem('qthLongitude')||'0');
        if(!isNaN(lat)&&lat!==0&&!isNaN(lon)&&lon!==0) return {lat,lon};
        return null;
    }
    
    let ipAddress = null;

    async function fetchIpAddress() {
        const host = WebserverURL; 
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
            return host;
        }
        try {
            const dnsRes = await fetch(`https://dns.google/resolve?name=${host}&type=A`);
            const dnsJson = await dnsRes.json();
            if (dnsJson.Answer && dnsJson.Answer.length) {
                const aRecord = dnsJson.Answer.find(r => r.type === 1);
                if (aRecord && aRecord.data) {
                    return aRecord.data;
                }
            }
        } catch (e) {}
        try {
            const res = await fetch('https://api.ipify.org?format=json');
            const json = await res.json();
            return json.ip;
        } catch (e) {}
        return host;
    }

    function setupDataPluginsWebSocket(){
        if(ws&&ws.readyState!==WebSocket.CLOSED) return;
        try{
            ws=new WebSocket(WEBSOCKET_URL);
            ws.addEventListener('open', async () => {
                debugLog('DataPlugins WS opened. Fetching IP...');
                if (!ipAddress) {
                    ipAddress = await fetchIpAddress();
                }
                debugLog(`IP fetched: ${ipAddress}. Sending Rotor request...`);
                // Send Rotor position request on connect
                const requestPayload = JSON.stringify({
                    type: 'Rotor',
                    value: 'request',
                    source: ipAddress,
                    clientId: clientId
                });
                debugLog(`Sent payload: ${requestPayload}`);
                ws.send(requestPayload);
            });
            
            ws.addEventListener('message',evt=>{ 
                try {
                    const d=JSON.parse(evt.data);
                    
                    // GPS Parsing
                    if(d.type==='GPS'&&d.value?.status==='active'){
                        gpsLat=parseFloat(d.value.lat);
                        gpsLon=parseFloat(d.value.lon);
                    }
                    
                    // Rotor Parsing
                    if(d.type==='Rotor'){
                        // 1. Read auth data (important for admin rights)
                        if (d.value === 'request' && d.clientId === clientId && d._auth) {
                            isAdminLoggedIn = d._auth.admin === true;
                            isTuneLoggedIn = d._auth.tune === true;
                            debugLog(`Auth updated: Admin=${isAdminLoggedIn}, Tune=${isTuneLoggedIn}`);
                        }
                        
                        // 2. Read lock status
                        if (d.lock !== undefined) {
                            isLockAuthenticated = d.lock;
                        }

                        // 3. Process real server responses from PST Rotator (127.0.0.1)
                        if (d.value !== undefined && d.value !== 'request' && d.source === '127.0.0.1') {
                            const pos = parseFloat(d.value);
                            
                            if(!isNaN(pos) && pos >= 0 && pos <= 360){
                                lastRotorAzimuth = pos === 360 ? 0 : pos;
                                
                                // Show lock button and remove red X when real server data arrives
                                const compassLockBtn = document.getElementById('as-compass-lock');
                                const compassClearBtn = document.getElementById('as-compass-clear');
                                
                                if (compassLockBtn && compassLockBtn.style.display === 'none') {
                                    compassLockBtn.style.display = 'flex'; 
                                    if (compassClearBtn) compassClearBtn.style.display = 'none';
                                    
                                    // Re-render detail view if open, to make azimuth clickable
                                    if (_activeTxKey && document.getElementById('as-tx-detail-panel').style.display === 'flex') {
                                        const txObj = Object.values(_persistentCrossings).flatMap(m=>Object.values(m)).find(c=>(c.tx.lat+'_'+c.tx.lon+'_'+c.tx.freq)===_activeTxKey)?.tx;
                                        if(txObj) renderTxDetailsContent(_activeTxKey, txObj);
                                    }
                                }

                                if (isCompassLocked) {
                                    updateCompassFromRotor();
                                    redrawFiltered();
                                } else if (document.getElementById('as-header-info')?.style.display === 'block') {
                                    redrawFiltered();
                                }
                            }
                        }
                    }
                }catch(e){
                    debugLog('Error parsing WS message:', e);
                } 
            });
            
            ws.addEventListener('close',() => {
                debugLog('DataPlugins WS closed. Reconnecting in 5s...');
                setTimeout(setupDataPluginsWebSocket,5000);
            });
        }catch(e){
            debugLog('Error setting up DataPlugins WS:', e);
        }
    }

    function startCountdownTick(){
        if(countdownTimer) return;
        countdownTimer=setInterval(()=>{
            if(!mapActive||!mapInstance) return;
            redrawFiltered();
        }, COUNTDOWN_TICK_MS);
    }

    // ── Data Fetching ────────────────────────────────────────────────────
    const DB_CACHE_KEY='as_fmdx_db', DB_CACHE_TS='as_fmdx_ts', DB_CACHE_LOC='as_fmdx_loc';

    function isFmdxCacheValid(currentLat, currentLon) {
        const ts = parseInt(localStorage.getItem(DB_CACHE_TS) || '0');
        if (Date.now() - ts > DB_CACHE_HOURS * 3600000) return false; 
        
        try {
            const locStr = localStorage.getItem(DB_CACHE_LOC);
            if (!locStr) return false;
            const loc = JSON.parse(locStr);
            if (haversineKm(currentLat, currentLon, loc.lat, loc.lon) > 100) return false; 
        } catch(e) {
            return false;
        }
        return true;
    }

    async function loadTxDatabase(lat, lon) {
        if (isFmdxCacheValid(lat, lon)) {
            try { 
                const raw = localStorage.getItem(DB_CACHE_KEY); 
                if (raw) {
                    await new Promise(r => setTimeout(r, 5)); // Short pause before the large JSON parse
                    return JSON.parse(raw); 
                }
            } catch(e) {}
        }
        
        const directUrl = FMDX_API_BASE + '?qth=' + encodeURIComponent(lat + ',' + lon);
        let data = null;
        try { const r = await fetch(directUrl); if (r.ok) data = await r.json(); } catch(e) {}
        
        if (!data) { 
            try {
                const r = await fetch(corsAnywhereUrl + directUrl); 
                if(!r.ok) throw new Error('HTTP '+r.status);
                data = await r.json(); 
            } catch(e) { throw new Error('TX DB Fetch failed'); }
        }

        const locs = data.locations || data;
        if (!locs || typeof locs !== 'object') throw new Error('Invalid TX DB format');

        // Calculate bounding box limit (1 degree = approx. 111 km)
        const latDelta = S.txRadiusKm / 111.0;
        const lonDelta = S.txRadiusKm / Math.max(0.1, Math.abs(111.0 * Math.cos(lat * Math.PI / 180)));

        const stations = []; 
        const locIds = Object.keys(locs);
        let lastYield = performance.now();
        
        for (let i = 0; i < locIds.length; i++) {
            // Time-based "breathing" instead of static counter
            if (performance.now() - lastYield > 10) {
                await new Promise(r => setTimeout(r, 5)); 
                lastYield = performance.now();
            }

            const locId = locIds[i];
            const loc = locs[locId]; 
            if (!loc || !Array.isArray(loc.stations)) continue;
            
            const locLat = parseFloat(loc.lat), locLon = parseFloat(loc.lon);
            
            // SUPER-FAST pre-filter: Is the location roughly in the search rectangle?
            if (Math.abs(locLat - lat) > latDelta || Math.abs(locLon - lon) > lonDelta) continue;
            
            // Only now calculate the exact (compute-intensive) circular distance
            const dist = haversineKm(lat, lon, locLat, locLon);
            if (dist > S.txRadiusKm) continue;
            
            loc.stations.forEach(st => {
                const fMHz = parseFloat(st.freq), erp = parseFloat(st.erp);
                if (fMHz < 87.5 || fMHz > 108.0 || isNaN(erp) || erp < S.minTxErpKw) return;
                stations.push({ id: st.id, freq: fMHz, city: loc.name || '', itu: loc.itu || '', erp, lat: locLat, lon: locLon, dist: Math.round(dist), terrainM: 0, station: st.station||'', ps: st.ps||'', pol: st.pol||'' });
            });
        }
        
        try {
            await new Promise(r => setTimeout(r, 5)); // Pause before saving in localStorage
            localStorage.setItem(DB_CACHE_KEY, JSON.stringify(stations)); 
            localStorage.setItem(DB_CACHE_TS, String(Date.now()));
            localStorage.setItem(DB_CACHE_LOC, JSON.stringify({lat, lon}));
        } catch(e) {
            console.warn('[Airplane Scatter] Not enough space to cache FMDX DB.');
        }

        return stations;
    }

    const ADSB_SOURCES = [
        {
            name: 'adsb.one',
            buildUrl: (lat, lon, km) => corsAnywhereUrl + 'https://api.adsb.one/v2/point/' + lat.toFixed(4) + '/' + lon.toFixed(4) + '/' + Math.min(Math.max(Math.round(km * 0.53996), 1), 250),
            parse: d => d?.ac ? d.ac.filter(a => a.lat && a.lon && a.alt_baro !== 'ground').map(a => ({
                icao24: (a.hex||'').toLowerCase(), callsign: (a.flight||a.r||'').trim(), lat: a.lat, lon: a.lon,
                alt_ft: typeof a.alt_baro==='number'?a.alt_baro:(a.alt_geom||0), speed: a.gs||0, track: a.track!==undefined?a.track:null,
                vspeed: a.baro_rate||a.geom_rate||null, category: a.category||'A3'
            })) : []
        },
        {
            name: 'adsb.lol',
            buildUrl: (lat, lon, km) => corsAnywhereUrl + 'https://api.adsb.lol/v2/point/' + lat.toFixed(4) + '/' + lon.toFixed(4) + '/' + Math.min(Math.max(Math.round(km * 0.53996), 1), 250),
            parse: d => d?.ac ? d.ac.filter(a => a.lat && a.lon && a.alt_baro !== 'ground').map(a => ({
                icao24: (a.hex||'').toLowerCase(), callsign: (a.flight||a.r||'').trim(), lat: a.lat, lon: a.lon,
                alt_ft: typeof a.alt_baro==='number'?a.alt_baro:(a.alt_geom||0), speed: a.gs||0, track: a.track!==undefined?a.track:null,
                vspeed: a.baro_rate||a.geom_rate||null, category: a.category||'A3'
            })) : []
        },
        {
            name: 'adsb.fi',
            buildUrl: (lat, lon, km) => corsAnywhereUrl + 'https://api.adsb.fi/v2/point/' + lat.toFixed(4) + '/' + lon.toFixed(4) + '/' + Math.min(Math.max(Math.round(km * 0.53996), 1), 250),
            parse: d => d?.ac ? d.ac.filter(a => a.lat && a.lon && a.alt_baro !== 'ground').map(a => ({
                icao24: (a.hex||'').toLowerCase(), callsign: (a.flight||a.r||'').trim(), lat: a.lat, lon: a.lon,
                alt_ft: typeof a.alt_baro==='number'?a.alt_baro:(a.alt_geom||0), speed: a.gs||0, track: a.track!==undefined?a.track:null,
                vspeed: a.baro_rate||a.geom_rate||null, category: a.category||'A3'
            })) : []
        }
    ];

    let _adsbSourceIndex = 0;
    async function fetchAircraft(lat, lon, radiusKm) {
        radiusKm = (radiusKm && !isNaN(radiusKm) && radiusKm > 0) ? radiusKm : 750;
        for (let attempt = 0; attempt < ADSB_SOURCES.length; attempt++) {
            const srcIdx = (_adsbSourceIndex + attempt) % ADSB_SOURCES.length;
            const src = ADSB_SOURCES[srcIdx];
            try {
                const ctrl = new AbortController();
                const tid = setTimeout(() => ctrl.abort(), 12000);
                const resp = await fetch(src.buildUrl(lat, lon, radiusKm), { signal: ctrl.signal });
                clearTimeout(tid);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const data = await resp.json();
                const aircraft = src.parse(data);
                _adsbSourceIndex = srcIdx; 
                return aircraft;
            } catch(err) {
                console.warn('[Airplane Scatter] ADS-B Source Failed:', src.name, err.message);
            }
        }
        throw new Error('All ADS-B APIs unavailable');
    }

    function ensureLeaflet(cb){
        if(typeof L !== 'undefined' && leafletReady){cb();return;}
        leafletCbs.push(cb); if(leafletCbs.length>1)return;
        if(!document.getElementById('as-leaflet-css')){
            const lnk=document.createElement('link');lnk.id='as-leaflet-css';lnk.rel='stylesheet';
            lnk.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';document.head.appendChild(lnk);
        }
        const scr=document.createElement('script');scr.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        scr.onload=()=>{leafletReady=true; leafletCbs.forEach(fn=>fn()); leafletCbs=[];};
        document.head.appendChild(scr);
    }

    async function startUpdate(forceReload){
        const rx=getRxCoords(); if(!rx) return;
        const reloadBtn=document.getElementById('as-reload');
        if(reloadBtn)reloadBtn.classList.add('spinning');
        updateStatusText('⏳ Loading...', 0, 0, 0);

        if(forceReload||_rxTerrainM===0){ 
            _rxTerrainM=await fetchElevationSingle(rx.lat,rx.lon); 
            _rxElevM=_rxTerrainM+S.rxAglM; 
            
            const rxTerrainUI = document.getElementById('as-rx-terrain-val');
            if(rxTerrainUI) rxTerrainUI.textContent = Math.round(_rxTerrainM);
        }
        
        updateRxMarkerTooltip(rx);

        try {
            txStations = await loadTxDatabase(rx.lat, rx.lon);
            txStationGrid = await buildTxGridAsync(txStations);
            updateRxMarkerTooltip(rx); 
            enrichTxElevations(txStations).then(async () => {
                txStationGrid = await buildTxGridAsync(txStations);
                if(mapInstance) redrawFiltered();
            });
        } catch(e) {
            updateStatusText('⚠ TX DB Error: '+e.message, 0, 0, 0);
            if(reloadBtn)reloadBtn.classList.remove('spinning'); return;
        }

        let fetchedAircraft = [];
        try {
            fetchedAircraft=await fetchAircraft(rx.lat,rx.lon,S.aircraftRadiusKm);
        } catch(e) {
            updateStatusText('⚠ ADS-B Error: '+e.message, 0, txStations.length, 0);
            if(reloadBtn)reloadBtn.classList.remove('spinning'); return;
        }

        const now = Date.now();
        fetchedAircraft.forEach(ac => { _activeAircraft[ac.icao24] = { ...ac, _lastSeen: now }; });

        const robustList = [];
        for(let icao in _activeAircraft) {
            let ac = _activeAircraft[icao];
            if(now - ac._lastSeen > AIRCRAFT_TIMEOUT_MS) { delete _activeAircraft[icao]; } 
            else {
                const staleSec = (now - ac._lastSeen) / 1000;
                if (staleSec > 1 && ac.track !== null && ac.speed > 0) {
                    const dr = deadReckon(ac.lat, ac.lon, ac.track, ac.speed, staleSec);
                    robustList.push({...ac, lat: dr.lat, lon: dr.lon});
                } else { robustList.push(ac); }
            }
        }

        await computePersistentCrossings(robustList, rx.lat, rx.lon);
        _lastFetchTime=now;

        ensureLeaflet(()=>{ if(mapInstance) redrawFiltered(); });
        
        let activeCandsCount = getPrimaryCrossings(getActiveVisibleCrossings()).length;
        updateStatusText(new Date().toTimeString().slice(0,8), robustList.length, txStations.length, activeCandsCount);
        if(reloadBtn)reloadBtn.classList.remove('spinning');
    }

    function createButton(){
        (function waitForPanel(){
            const obs=new MutationObserver((_,o)=>{
                if(typeof addIconToPluginPanel!=='function') return;
                o.disconnect();
                // Add Plugin Version to Tooltip!
                addIconToPluginPanel('AIRPLANESCATTER-on-off','Scatter','solid','plane',`Airplane Scatter v${pluginVersion}`);
                const btnObs=new MutationObserver(()=>{
                    const btn=document.getElementById('AIRPLANESCATTER-on-off');
                    if(!btn) return; 
                    btnObs.disconnect(); 
                    btn.classList.add('hide-phone','bg-color-2');
                    btn.title = `Airplane Scatter v${pluginVersion}`; // Make sure tooltip is set
                    btn.addEventListener('click',()=>{
                        if (!mapActive) {
                            const rx = getRxCoords();
                            if (!rx) {
                                alert("Airplane Scatter: No GPS signal or QTH configured. Please wait or enter it in the settings.");
                                return;
                            }
                            mapActive = true;
                            btn.classList.add('active');
                            openMap(rx.lat, rx.lon);
                        } else {
                            mapActive = false;
                            btn.classList.remove('active');
                            closeMap();
                        }
                    });
                });
                btnObs.observe(document.body,{childList:true,subtree:true});
            });
            obs.observe(document.body,{childList:true,subtree:true});
        })();
    }

    function openMap(rxLat, rxLon){
        createMapContainer(rxLat, rxLon);
        ensureLeaflet(()=>{
            startUpdate(false);
            setupMainWebSocket();
            setupRdsWebSocket();
            if(aircraftTimer)clearInterval(aircraftTimer);
            aircraftTimer=setInterval(()=>{if(mapActive)startUpdate(false);},AIRCRAFT_UPDATE_MS);
            startCountdownTick();
        });
    }

    loadCountryLookup().then(map => {
        ituToFlag = map;
    }).catch(err => {
        ituToFlag = {};
    });

    setupDataPluginsWebSocket(); // Setup websocket for GPS and Rotor
    createButton();

})();