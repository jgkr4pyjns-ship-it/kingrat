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

// ---------------------------------------------------------
// QUALITY EXTRACTOR (Prevents Stremio from hiding streams)
// ---------------------------------------------------------
function extractQuality(title) {
  const t = title.toLowerCase();
  if (t.includes('4k') || t.includes('uhd') || t.includes('2160p')) return '4K UHD 💎';
  if (t.includes('1080p') || t.includes('fhd')) return '1080p FHD';
  if (t.includes('720p') || t.includes('hd')) return '720p HD';
  return 'SD / Unknown';
}

// ---------------------------------------------------------
// STALKER SEARCH (Upgraded to fetch multiple pages)
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

    let results = [];
    
    // Loop through up to 4 pages to bypass the 14-item Stalker limit
    for (let page = 1; page <= 4; page++) {
      const searchUrl = `${baseUrl}?type=vod&action=get_ordered_list&search=${encodeURIComponent(searchQuery)}&p=${page}`;
      const searchRes = await axios.get(searchUrl, { headers, timeout: 8000 });
      
      if (searchRes.data?.js?.data && Array.isArray(searchRes.data.js.data)) {
        const movies = searchRes.data.js.data;
        if (movies.length === 0) break; // If page is empty, stop searching

        for (let movie of movies) {
          const linkRes = await axios.get(`${baseUrl}?type=vod&action=create_link&cmd=${encodeURIComponent(movie.cmd)}`, { headers, timeout: 8000 });
          if (linkRes.data?.js?.cmd) {
            const rawCmd = linkRes.data.js.cmd;
            const match = rawCmd.match(/https?:\/\/[^\s]+/);
            
            if (match) {
              const quality = extractQuality(movie.name);
              results.push({ 
                name: `Nuvio [${quality}]`, 
                title: `[STALKER]\n${movie.name}`, 
                url: match[0] 
              });
            }
          }
        }
      } else {
        break; // Stop if the API response is invalid
      }
    }
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
          results.push({ 
            name: `Nuvio [${quality}]`, 
            title: `[M3U]\n${rawTitle}`, 
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
  if (!config) return res.status(200).json({ id: 'org.nuvio.error', version: '4.2.0', name: 'Nuvio (Invalid)', resources: [], types: [] });

  res.status(200).json({
    id: `org.nuvio.stateless`,
    version: '4.2.0',
    name: `Nuvio 👑 (${config.playlists.length} Sources)`,
    description: 'Cloud engine for Stalker and M3U VOD. Now with 4K Detection.',
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
    <head><title>Nuvio</title><script src="https://cdn.tailwindcss.com"></script></head>
    <body class="bg-slate-950 text-white p-8 max-w-2xl mx-auto font-sans">
      <h1 class="text-3xl font-black text-indigo-500 mb-6">NUVIO <span class="text-xs text-indigo-200">v4.2 Cloud Edition</span></h1>
      <p class="text-sm text-slate-400 mb-6">Make sure your Stalker URL has a valid domain (e.g. .com or .tv) and put the MAC Address in the second box.</p>
      <div id="sources" class="space-y-4"></div>
      <button onclick="addSourceRow()" class="mt-4 bg-slate-800 px-4 py-2 rounded text-sm hover:bg-slate-700 transition">+ Add Source</button>
      <div class="mt-8 pt-6 border-t border-slate-800">
        <button onclick="generateUrl()" class="w-full bg-indigo-500 hover:bg-indigo-400 text-slate-950 font-black py-3 rounded transition">Generate Manifest URL</button>
        <div id="resultBox" class="hidden mt-4 space-y-2 p-4 bg-slate-900 border border-indigo-500/30 rounded">
          <input type="text" id="manifestUrl" readonly class="w-full bg-slate-950 p-2 text-indigo-400 font-mono text-xs focus:outline-none" />
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
            <input type="text" placeholder="Portal URL (http://server.com/c/)" class="url w-full bg-slate-950 p-2 text-sm border border-slate-800 focus:border-indigo-500 focus:outline-none" />
            <input type="text" placeholder="MAC Address (00:1A:79:...)" class="creds w-full bg-slate-950 p-2 text-sm border border-slate-800 focus:border-indigo-500 focus:outline-none" />
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
app.listen(PORT, () => console.log(`Nuvio Cloud Engine running on port ${PORT}`));
