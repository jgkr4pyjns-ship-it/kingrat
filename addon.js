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

// ---------------------------------------------------------
// STALKER SEARCH (True Category Scraper + Anti-Spam Batching)
// ---------------------------------------------------------
async function searchStalker(portalUrl, macAddress, searchQuery) {
  if (!macAddress) return [];
  try {
    let baseUrl = portalUrl.trim();
    if (baseUrl.endsWith('/c/')) baseUrl = baseUrl.replace('/c/', '/server/load.php');
    else if (!baseUrl.includes('load.php')) baseUrl = baseUrl.endsWith('/') ? baseUrl + 'server/load.php' : baseUrl + '/server/load.php';

    const headers = { 'Cookie': `mac=${macAddress}`, 'User-Agent': 'Mozilla/5.0' };
    const handshake = await axios.get(`${baseUrl}?type=stb&action=handshake`, { headers, timeout: 8000 });
    if (handshake.data?.js?.token) headers['Authorization'] = `Bearer ${handshake.data.js.token}`;

    const cleanName = searchQuery.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    const queryWords = cleanName.toLowerCase().split(/\s+/);
    let primaryWord = queryWords[0];
    if ((primaryWord === 'the' || primaryWord === 'a') && queryWords[1]) primaryWord = queryWords[1];

    let categories = [];
    try {
      // 1. Actually fetch the categories this time
      const catRes = await axios.get(`${baseUrl}?type=vod&action=get_categories`, { headers, timeout: 5000 });
      if (catRes.data?.js && Array.isArray(catRes.data.js)) categories = catRes.data.js;
    } catch (err) {}
    
    if (categories.length === 0) categories = [{ id: '*', title: 'All' }];

    let allMovies = [];
    const seenCmds = new Set();
    
    // 2. Batch fetching 6 categories at a time to stay under anti-spam radar but fast enough for Stremio's 10s timeout
    const BATCH_SIZE = 6;
    for (let i = 0; i < categories.length; i += BATCH_SIZE) {
      const batch = categories.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(cat => 
         axios.get(`${baseUrl}?type=vod&action=get_ordered_list&category=${cat.id}&search=${encodeURIComponent(primaryWord)}&p=0`, { headers, timeout: 5000 })
           .then(res => ({ cat, data: res.data }))
           .catch(() => null)
      );
      
      const batchResults = await Promise.all(batchPromises);
      for (const res of batchResults) {
         if (res?.data?.js?.data && Array.isArray(res.data.js.data)) {
            for (const movie of res.data.js.data) {
               if (!seenCmds.has(movie.cmd)) {
                  seenCmds.add(movie.cmd);
                  movie.categoryName = res.cat.title;
                  allMovies.push(movie);
               }
            }
         }
      }
    }

    // 3. Strict javascript matching to bypass provider SQL search bugs
    const filteredMovies = allMovies.filter(m => {
      const mName = (m.name || '').toLowerCase();
      let matchCount = 0;
      queryWords.forEach(qw => { if (mName.includes(qw)) matchCount++; });
      return matchCount >= Math.min(2, queryWords.length);
    });

    // Cap at 15 to ensure we don't hit the 10s Stremio timeout during link resolution
    const targetMovies = filteredMovies.length > 0 ? filteredMovies.slice(0, 15) : allMovies.slice(0, 10);
    if (targetMovies.length === 0) return [];

    // 4. Resolve links in batches of 5
    let resolvedLinks = [];
    const LINK_BATCH_SIZE = 5;
    for (let i = 0; i < targetMovies.length; i += LINK_BATCH_SIZE) {
       const batch = targetMovies.slice(i, i + LINK_BATCH_SIZE);
       const linkPromises = batch.map(async (movie) => {
         try {
           const linkRes = await axios.get(`${baseUrl}?type=vod&action=create_link&cmd=${encodeURIComponent(movie.cmd)}`, { headers, timeout: 6000 });
           if (linkRes.data?.js?.cmd) {
             const match = linkRes.data.js.cmd.match(/https?:\/\/[^\s]+/);
             if (match) {
               const rawTitle = movie.name || "Unknown Title";
               const quality = extractQuality(rawTitle);
               return {
                 name: `[STALKER] ${quality}`,
                 title: `${rawTitle}\n📂 Found in: ${movie.categoryName || "Root"}`,
                 url: match[0]
               };
             }
           }
         } catch (err) {
           return null;
         }
         return null;
       });
       const batchResolved = await Promise.all(linkPromises);
       resolvedLinks.push(...batchResolved);
    }
    
    let results = [];
    const seenUrls = new Set();
    resolvedLinks.forEach(link => {
      if (link && !seenUrls.has(link.url)) {
        seenUrls.add(link.url);
        results.push(link);
      }
    });

    return results;
  } catch (err) {
    console.error(`Stalker Error: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------
// M3U SEARCH
// ---------------------------------------------------------
async function searchM3U(playlistUrl, searchQuery) {
  try {
    const response = await axios.get(playlistUrl, { responseType: 'text', timeout: 10000 });
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
  if (!config) return res.status(200).json({ id: 'org.kingrat.error', version: '4.9.0', name: 'KingRat (Invalid)', resources: [], types: [] });

  res.status(200).json({
    id: `org.kingrat.stateless`,
    version: '4.9.0',
    name: `KingRat 👑 (${config.playlists.length} Sources)`,
    description: 'Cloud engine for Stalker and M3U VOD. True Category Search and rate-limit bypassing.',
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

  let allStreams = [];
  for (const playlist of config.playlists) {
    if (playlist.type === 'stalker') allStreams = allStreams.concat(await searchStalker(playlist.url, playlist.creds, meta.name));
    else if (playlist.type === 'm3u') allStreams = allStreams.concat(await searchM3U(playlist.url, meta.name));
  }
  res.status(200).json({ streams: allStreams });
});

app.get('/', (req, res) => res.redirect('/configure'));

app.get('/configure', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>KingRat</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-950 text-white p-8 max-w-2xl mx-auto font-sans">
      <h1 class="text-3xl font-black text-amber-500 mb-6">KING RAT <span class="text-xs text-amber-200">v4.9 Cloud Edition</span></h1>
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
