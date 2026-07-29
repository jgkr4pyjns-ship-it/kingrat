const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

function decodeConfig(hexString) {
  try {
    const jsonStr = Buffer.from(hexString, 'hex').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (err) {
    return null;
  }
}

async function getMediaMetadata(type, id) {
  try {
    const imdbId = id.split(':')[0]; 
    const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
    return res.data.meta;
  } catch (err) {
    return null;
  }
}

function extractQuality(title) {
  const t = title.toLowerCase();
  if (/4k|uhd|2160/.test(t)) return '4K';
  if (/1080|fhd/.test(t)) return '1080p';
  if (/720|hd/.test(t)) return '720p';
  return 'SD';
}

// Global Category Cache to save precious seconds on Stalker searches
if (!global.catCache) global.catCache = {};

// ---------------------------------------------------------
// STALKER SEARCH (v5.4 Internal Stopwatch & Caching)
// ---------------------------------------------------------
async function searchStalker(portalUrl, macAddress, searchQuery) {
  if (!macAddress) return [];
  
  const startTime = Date.now();
  let results = [];

  try {
    let baseUrl = portalUrl.trim();
    if (baseUrl.endsWith('/c/')) baseUrl = baseUrl.replace('/c/', '/server/load.php');
    else if (!baseUrl.includes('load.php')) baseUrl = baseUrl.endsWith('/') ? baseUrl + 'server/load.php' : baseUrl + '/server/load.php';

    const headers = { 'Cookie': `mac=${macAddress}`, 'User-Agent': 'Mozilla/5.0' };
    
    // 1. Handshake
    const handshake = await axios.get(`${baseUrl}?type=stb&action=handshake`, { headers, timeout: 3000 }).catch(() => null);
    if (handshake?.data?.js?.token) headers['Authorization'] = `Bearer ${handshake.data.js.token}`;

    // 2. Clean query to bypass SQL errors (single primary word)
    const ignoreWords = ['the', 'and', 'for', 'with', 'part', 'vol', 'chapter', 'of'];
    const queryWords = searchQuery.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !ignoreWords.includes(w.toLowerCase()));
    const primaryWord = queryWords[0] || searchQuery.split(' ')[0];

    // 3. CACHED CATEGORY FETCH (Saves ~1.5 seconds on repeat searches)
    let categories = global.catCache[baseUrl];
    if (!categories) {
      try {
        const catRes = await axios.get(`${baseUrl}?type=vod&action=get_categories`, { headers, timeout: 3000 });
        if (catRes.data?.js && Array.isArray(catRes.data.js)) {
          categories = catRes.data.js;
          global.catCache[baseUrl] = categories; // Save to RAM
        }
      } catch (err) {
        categories = [];
      }
    }

    // Target Root + 4K/UHD folders first
    let targetCats = [];
    if (categories && categories.length > 0) {
      const highValue = categories.filter(c => /4k|uhd|movies|cinema|english|en/i.test(c.title));
      highValue.sort((a, b) => (/4k|uhd/i.test(b.title) ? 1 : 0) - (/4k|uhd/i.test(a.title) ? 1 : 0));
      targetCats = [{ id: '*', title: 'All' }, ...highValue];
    } else {
      targetCats = [{ id: '*', title: 'All' }];
    }
    const uniqueCats = Array.from(new Map(targetCats.map(item => [item.id, item])).values());

    let allMovies = [];
    const seenCmds = new Set();

    // 4. SEQUENTIAL FOLDER SEARCH (Bypasses Firewall, bounded by time)
    for (const cat of uniqueCats) {
      // STOPWATCH: If we have spent more than 4.5 seconds searching folders, STOP and move to link generation
      if (Date.now() - startTime > 4500) break;
      
      try {
        const searchUrl = `${baseUrl}?type=vod&action=get_ordered_list&category=${cat.id}&search=${encodeURIComponent(primaryWord)}&p=0`;
        const res = await axios.get(searchUrl, { headers, timeout: 3000 });
        if (res.data?.js?.data && Array.isArray(res.data.js.data)) {
          for (const movie of res.data.js.data) {
            if (!seenCmds.has(movie.cmd)) {
              seenCmds.add(movie.cmd);
              movie.categoryName = cat.title;
              allMovies.push(movie);
            }
          }
        }
      } catch (e) {
        // Ignore errors to keep the loop moving
      }
    }

    // 5. Strict Match Filtering
    const filteredMovies = allMovies.filter(m => {
      const mName = (m.name || '').toLowerCase();
      let matchCount = 0;
      queryWords.forEach(qw => { if (mName.includes(qw.toLowerCase())) matchCount++; });
      return matchCount >= Math.min(2, queryWords.length);
    });

    if (filteredMovies.length === 0) return [];

    // 6. PRIORITY SORT: Push 4K and 1080p to the top so they get processed before the timer runs out
    filteredMovies.sort((a, b) => {
      const nameA = (a.name || "").toLowerCase();
      const nameB = (b.name || "").toLowerCase();
      const scoreA = /4k|uhd|2160/i.test(nameA) ? 3 : /1080/i.test(nameA) ? 2 : /720/i.test(nameA) ? 1 : 0;
      const scoreB = /4k|uhd|2160/i.test(nameB) ? 3 : /1080/i.test(nameB) ? 2 : /720/i.test(nameB) ? 1 : 0;
      return scoreB - scoreA;
    });

    const seenUrls = new Set();

    // 7. SEQUENTIAL LINK RESOLUTION (Bypasses Firewall)
    for (const movie of filteredMovies) {
      // STOPWATCH 2: If we hit 7.5 seconds total, STOP immediately and return what we have to Stremio.
      if (Date.now() - startTime > 7500) break;

      try {
        const linkUrl = `${baseUrl}?type=vod&action=create_link&cmd=${encodeURIComponent(movie.cmd)}`;
        const linkRes = await axios.get(linkUrl, { headers, timeout: 3000 });
        if (linkRes.data?.js?.cmd) {
          const match = linkRes.data.js.cmd.match(/https?:\/\/[^\s]+/);
          if (match && !seenUrls.has(match[0])) {
            seenUrls.add(match[0]);
            const rawTitle = movie.name || "Unknown Title";
            const quality = extractQuality(rawTitle);
            
            results.push({
              name: `[STALKER] ${quality}`,
              title: `${rawTitle}\n📂 Found in: ${movie.categoryName}`,
              url: match[0]
            });
          }
        }
      } catch (e) {
        // Ignore timeouts on dead links
      }
    }

    return results;
  } catch (err) {
    return results; // Fail gracefully
  }
}

// ---------------------------------------------------------
// M3U SEARCH
// ---------------------------------------------------------
async function searchM3U(playlistUrl, searchQuery) {
  try {
    const response = await axios.get(playlistUrl, { responseType: 'text', timeout: 6000 });
    const lines = response.data.split('\n');
    let results = [];
    const normalizedQuery = searchQuery.toLowerCase().replace(/[^a-z0-9]/g, '');

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXTINF') && lines[i].toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalizedQuery)) {
        let streamUrl = lines[i + 1] ? lines[i + 1].trim() : '';
        let offset = 1;
        while (!streamUrl.startsWith('http') && offset < 5 && lines[i + offset]) {
          streamUrl = lines[i + offset].trim();
          offset++;
        }
        if (streamUrl.startsWith('http')) {
          const rawTitle = lines[i].split(',').pop().trim();
          const quality = extractQuality(rawTitle);
          const groupMatch = lines[i].match(/group-title="([^"]+)"/i);
          const categoryName = groupMatch ? groupMatch[1] : "Playlist";
          
          results.push({ 
            name: `[M3U] ${quality}`, 
            title: `${rawTitle}\n📂 Found in: ${categoryName}`, 
            url: streamUrl 
          });
        }
      }
    }
    return results;
  } catch (err) {
    return [];
  }
}

app.get('/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(200).json({ id: 'org.kingrat.error', version: '5.4.0', name: 'KingRat (Invalid)', resources: [], types: [] });

  res.status(200).json({
    id: `org.kingrat.stateless`,
    version: '5.4.0',
    name: `KingRat 👑 (${config.playlists.length} Sources)`,
    description: 'Cloud engine for Stalker and M3U VOD. v5.4 Human Emulator & RAM Cache enabled.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
  });
});

app.get('/:config/stream/:type/:imdbId.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.json({ streams: [] });

  const meta = await getMediaMetadata(req.params.type, req.params.imdbId);
  if (!meta || !meta.name) return res.json({ streams: [] });

  // FIXED: Run all configured sources concurrently so they don't eat into each other's timers
  const streamPromises = config.playlists.map(async (playlist) => {
    if (playlist.type === 'stalker') return await searchStalker(playlist.url, playlist.creds, meta.name);
    if (playlist.type === 'm3u') return await searchM3U(playlist.url, meta.name);
    return [];
  });

  const results = await Promise.all(streamPromises);
  const allStreams = results.flat();

  res.status(200).json({ streams: allStreams });
});

app.get('/', (req, res) => res.redirect('/configure'));

app.get('/configure', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>KingRat</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-950 text-white p-8 max-w-2xl mx-auto font-sans">
      <h1 class="text-3xl font-black text-amber-500 mb-6">KING RAT <span class="text-xs text-amber-200">v5.4 Cloud Edition</span></h1>
      <p class="text-sm text-slate-400 mb-6">Make sure your Stalker URL has a valid domain (e.g. .com or .tv) and put the MAC Address in the second box.</p>
      <div id="sources" class="space-y-4"></div>
      <button onclick="addSourceRow()" class="mt-4 bg-slate-800 px-4 py-2 rounded text-sm">+ Add Source</button>
      <div class="mt-8 pt-6 border-t border-slate-800">
        <button onclick="generateUrl()" class="w-full bg-amber-500 text-slate-950 font-black py-3 rounded">Generate Manifest URL</button>
        <div id="resultBox" class="hidden mt-4 space-y-2 p-4 bg-slate-900 border border-amber-500/30 rounded">
          <input type="text" id="manifestUrl" readonly class="w-full bg-slate-950 p-2 text-amber-400 font-mono text-xs" />
        </div>
      </div>
      <script>
        function addSourceRow() {
          const div = document.createElement('div');
          div.className = 'p-4 bg-slate-900 border border-slate-800 rounded space-y-2 source-item';
          div.innerHTML = \`
            <select class="type bg-slate-950 text-xs p-1 text-slate-300 w-full mb-2 border border-slate-800">
              <option value="stalker">Stalker Portal</option>
              <option value="m3u">M3U Playlist URL</option>
            </select>
            <input type="text" placeholder="Portal URL (http://server.com/c/)" class="url w-full bg-slate-950 p-2 text-sm border border-slate-800 focus:border-amber-500" />
            <input type="text" placeholder="MAC Address (00:1A:79:...)" class="creds w-full bg-slate-950 p-2 text-sm border border-slate-800 focus:border-amber-500" />
          \`;
          document.getElementById('sources').appendChild(div);
        }
        
        function toHex(str) {
          return Array.from(new TextEncoder().encode(str)).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        function generateUrl() {
          const rows = document.querySelectorAll('.source-item');
          const playlists = Array.from(rows).map(r => ({ type: r.querySelector('.type').value, url: r.querySelector('.url').value.trim(), creds: r.querySelector('.creds').value.trim() })).filter(p => p.url);
          if(!playlists.length) return alert('Enter a URL');
          
          const hexData = toHex(JSON.stringify({ playlists }));
          const fullUrl = window.location.protocol + '//' + window.location.host + '/' + hexData + '/manifest.json';
          
          document.getElementById('manifestUrl').value = fullUrl;
          document.getElementById('resultBox').classList.remove('hidden');
        }
        addSourceRow();
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`KingRat Cloud Engine running on port ${PORT}`));
