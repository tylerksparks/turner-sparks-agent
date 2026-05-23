const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = 5000;

app.use(express.json());
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

/* ── PostgreSQL connection pool ── */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

/* Ensure tables exist on startup */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      cache_key TEXT PRIMARY KEY,
      leads JSONB NOT NULL,
      tab TEXT NOT NULL,
      params JSONB NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS history_index (
      cache_key TEXT PRIMARY KEY REFERENCES cache_entries(cache_key) ON DELETE CASCADE,
      tab TEXT NOT NULL,
      city TEXT NOT NULL,
      filters TEXT NOT NULL,
      display_date TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      note_key TEXT PRIMARY KEY,
      note_text TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  console.log('Database tables ready');
}
initDb().catch(err => console.error('DB init error:', err.message));

app.get('/api/history', async (req, res) => {
  try {
    const cutoff = Date.now() - CACHE_TTL_MS;
    const result = await pool.query(
      `SELECT h.cache_key AS key, h.tab, h.city, h.filters, h.display_date AS date, h.created_at AS timestamp
       FROM history_index h
       WHERE h.created_at > $1
       ORDER BY h.created_at DESC`,
      [cutoff]
    );
    res.json({ index: result.rows });
  } catch (err) {
    console.error('GET /api/history error:', err.message);
    res.json({ index: [] });
  }
});

app.post('/api/cache/get', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ entry: null });
  try {
    const cutoff = Date.now() - CACHE_TTL_MS;
    const result = await pool.query(
      'SELECT leads, tab, params, created_at AS timestamp FROM cache_entries WHERE cache_key = $1 AND created_at > $2',
      [key, cutoff]
    );
    if (result.rows.length === 0) return res.json({ entry: null });
    const row = result.rows[0];
    res.json({ entry: { leads: row.leads, tab: row.tab, params: row.params, timestamp: Number(row.timestamp) } });
  } catch (err) {
    console.error('POST /api/cache/get error:', err.message);
    res.json({ entry: null });
  }
});

app.post('/api/cache/save', async (req, res) => {
  const { key, leads, tab, params } = req.body;
  if (!key || !leads) return res.status(400).json({ error: 'Missing key or leads' });
  try {
    const now = Date.now();
    const city = tab === 'cmaa' ? params.state : params.city;
    const filtersArr = tab === 'cmaa'
      ? [`State: ${params.state}`, `Sender: ${params.sender === 'myrna' ? 'Myrna Midkiff' : 'Turner Sparks'}`]
      : [`Type: ${params.clubType}`, `Scope: ${params.searchScope}`, params.clubType !== 'comedy club' ? `Focus: ${params.eventFocus}` : null, `Sender: ${params.sender === 'myrna' ? 'Myrna Midkiff' : 'Turner Sparks'}`].filter(Boolean);
    const filters = filtersArr.join(' · ');
    const displayDate = new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    await pool.query(
      `INSERT INTO cache_entries (cache_key, leads, tab, params, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cache_key) DO UPDATE SET leads=$2, tab=$3, params=$4, created_at=$5`,
      [key, JSON.stringify(leads), tab, JSON.stringify(params), now]
    );
    await pool.query(
      `INSERT INTO history_index (cache_key, tab, city, filters, display_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (cache_key) DO UPDATE SET tab=$2, city=$3, filters=$4, display_date=$5, created_at=$6`,
      [key, tab, city, filters, displayDate, now]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/cache/save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cache/delete', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  try {
    await pool.query('DELETE FROM cache_entries WHERE cache_key = $1', [key]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/cache/delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/history/clear', async (req, res) => {
  try {
    await pool.query('DELETE FROM cache_entries');
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/history/clear error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Notes ── */
app.get('/api/notes', async (req, res) => {
  try {
    const result = await pool.query('SELECT note_key, note_text, updated_at FROM notes');
    const notes = {};
    result.rows.forEach(r => { notes[r.note_key] = { text: r.note_text, updatedAt: r.updated_at }; });
    res.json({ notes });
  } catch (err) {
    console.error('GET /api/notes error:', err.message);
    res.json({ notes: {} });
  }
});

app.post('/api/notes/save', async (req, res) => {
  const { noteKey, text } = req.body;
  if (!noteKey) return res.status(400).json({ error: 'Missing noteKey' });
  try {
    if (text && text.trim()) {
      const updatedAt = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      await pool.query(
        `INSERT INTO notes (note_key, note_text, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (note_key) DO UPDATE SET note_text=$2, updated_at=$3`,
        [noteKey, text.trim(), updatedAt]
      );
    } else {
      await pool.query('DELETE FROM notes WHERE note_key = $1', [noteKey]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/notes/save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function scrapeContactInfo(website) {
  if (!website) return { email: null, phone: null };
  const base = website.replace(/\/+$/, '');
  const pagesToTry = [base, base + '/contact', base + '/contact-us'];
  const emails = new Set();
  const phones = new Set();
  const BAD_EMAIL = /\.(png|jpg|gif|svg|css|js|woff|ttf)$|sentry|example\.|wixpress|schema\.org|cloudflare|@2x|pixel|tracking/i;
  for (const url of pagesToTry) {
    try {
      const r = await fetch(url, { timeout: 7000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' } });
      if (!r.ok) continue;
      const html = await r.text();
      const emailMatches = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
      emailMatches.forEach(e => { if (!BAD_EMAIL.test(e) && e.length < 80) emails.add(e.toLowerCase()); });
      const phoneMatches = html.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g) || [];
      phoneMatches.forEach(p => phones.add(p));
      if (emails.size >= 2) break;
    } catch (_) {}
  }
  const emailArr = [...emails];
  const preferredEmail = emailArr.find(e => /booking|event|entertain|contact|info|private/i.test(e)) || emailArr[0] || null;
  return { email: preferredEmail, phone: [...phones][0] || null };
}

async function hunterDomainSearch(domain, apiKey) {
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${apiKey}&limit=10`;
  const r = await fetch(url, { timeout: 10000 });
  const data = await r.json();
  if (!r.ok) {
    const isQuota = r.status === 429 || r.status === 402 || (data.errors && JSON.stringify(data.errors).toLowerCase().includes('limit'));
    return { ok: false, quota: isQuota, data: null };
  }
  return { ok: true, quota: false, data };
}

async function hunterLookup(clubName, website) {
  if (!website) return { name: null, title: null, email: null };
  const keys = [process.env.HUNTER_API_KEY, process.env.HUNTER_API_KEY_2].filter(Boolean);
  if (keys.length === 0) return { name: null, title: null, email: null };

  try {
    const domain = website.replace(/https?:\/\/(www\.)?/, '').split('/')[0];
    if (!domain) return { name: null, title: null, email: null };

    let data = null;
    for (const key of keys) {
      const result = await hunterDomainSearch(domain, key);
      if (result.ok) { data = result.data; break; }
      if (!result.quota) break; // non-quota error, don't try next key
      console.log(`[Hunter] ${clubName} — quota hit on key, trying backup key…`);
    }

    if (!data) { console.error(`[Hunter] ${clubName} — all keys exhausted or failed`); return { name: null, title: null, email: null }; }

    const emails = (data.data && data.data.emails) || [];
    const PRIORITY = /event|entertainment|private|booking|club manager|general manager|f&b|food/i;
    const scored = emails.map(e => ({
      name: [e.first_name, e.last_name].filter(Boolean).join(' ') || null,
      title: e.position || null,
      email: e.value || null,
      score: (PRIORITY.test(e.position || '') ? 10 : 0) + (e.confidence || 0)
    }));
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0] || {};
    console.log(`[Hunter] ${clubName}/${domain} — found ${emails.length} emails, best: ${best.name} / ${best.title} / ${best.email}`);
    return { name: best.name || null, title: best.title || null, email: best.email || null };
  } catch (err) {
    console.error(`[Hunter] ${clubName} error:`, err.message);
    return { name: null, title: null, email: null };
  }
}

function callAnthropic(prompt, maxTokens = 4096) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
  }).finally(() => clearTimeout(timer));
}

function parseJSON(text) {
  // 1. Direct parse
  try { return JSON.parse(text); } catch (_) {}

  // 2. Extract first [...] block and parse
  const m = text.match(/\[[\s\S]*\]/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}

    // 3. Response was probably truncated — salvage all complete objects
    let fragment = m[0];
    // Try truncating after the last complete object: `},` or `}` before end
    const lastComma = fragment.lastIndexOf('},');
    if (lastComma !== -1) {
      try { return JSON.parse(fragment.slice(0, lastComma + 1) + ']'); } catch (_) {}
    }
    const lastBrace = fragment.lastIndexOf('}');
    if (lastBrace !== -1) {
      try { return JSON.parse(fragment.slice(0, lastBrace + 1) + ']'); } catch (_) {}
    }
  }

  console.error('[parseJSON] Failed. Raw text (first 800 chars):', text.slice(0, 800));
  throw new Error('Could not parse JSON from AI response');
}

async function fetchHunterAccount(apiKey) {
  try {
    const r = await fetch(`https://api.hunter.io/v2/account?api_key=${apiKey}`, { timeout: 8000 });
    if (!r.ok) return null;
    const data = await r.json();
    const searches = data.data && data.data.requests && data.data.requests.searches;
    if (!searches) return null;
    const planLimit = searches.available ?? null;
    const used = searches.used ?? null;
    const remaining = (planLimit != null && used != null) ? planLimit - used : null;
    return { used, available: remaining, total: planLimit };
  } catch (_) { return null; }
}

app.get('/api/hunter-credits', async (req, res) => {
  const keys = [process.env.HUNTER_API_KEY, process.env.HUNTER_API_KEY_2].filter(Boolean);
  if (keys.length === 0) return res.json({ accounts: [] });
  const accounts = await Promise.all(keys.map((k, i) => fetchHunterAccount(k).then(r => r ? { label: i === 0 ? 'Account 1' : 'Account 2', ...r } : null)));
  res.json({ accounts: accounts.filter(Boolean) });
});

const PAST_CLUBS = [
  { name: 'Colonial Country Club', city: 'Fort Worth', state: 'TX', region: 'South / Southwest' },
  { name: 'Royal Oaks Country Club', city: 'Dallas', state: 'TX', region: 'South / Southwest' },
  { name: 'Dominion Country Club', city: 'San Antonio', state: 'TX', region: 'South / Southwest' },
  { name: 'Timarron Country Club', city: 'Southlake', state: 'TX', region: 'South / Southwest' },
  { name: 'Army Navy Country Club', city: 'Arlington', state: 'VA', region: 'Mid-Atlantic' },
  { name: 'Del Paso Country Club', city: 'Sacramento', state: 'CA', region: 'West Coast' },
  { name: 'Granite Bay Golf Club', city: 'Granite Bay', state: 'CA', region: 'West Coast' },
  { name: 'Serrano Country Club', city: 'El Dorado Hills', state: 'CA', region: 'West Coast' },
  { name: 'Eugene Country Club', city: 'Eugene', state: 'OR', region: 'Pacific Northwest' },
  { name: 'Corvallis Club', city: 'Corvallis', state: 'OR', region: 'Pacific Northwest' },
  { name: 'Friars Club', city: 'New York City', state: 'NY', region: 'Northeast' },
  { name: 'Hillwood Country Club', city: 'Nashville', state: 'TN', region: 'Southeast' },
  { name: 'Fort Lauderdale Country Club', city: 'Fort Lauderdale', state: 'FL', region: 'Southeast' },
  { name: 'Firethorne Country Club', city: 'Marvin', state: 'NC', region: 'Southeast' },
  { name: 'Country Club of North Carolina', city: 'Pinehurst', state: 'NC', region: 'Southeast' }
];

function buildSenderInstructions(sender, emailType, isComedyClub) {
  const isMyrna = sender === 'myrna';
  const isFollowUp = emailType === 'followup';
  const myrnaSignOff = `All the best,\nMyrna Midkiff, personal appearance manager for Turner Sparks\nwww.TurnerSparks.com`;
  return isMyrna
    ? isFollowUp
      ? `Written by Myrna Midkiff, Turner's mother and personal appearance manager, as a FOLLOW-UP EMAIL after she already spoke with this person by phone. First person as herself, refers to Turner in third person.

FOLLOW-UP EMAIL STYLE — follow this closely:
- Opens with "Hello again, [Name]," or "Great talking with you [today / this week / this afternoon], [Name],"
- Immediately references the phone call: "It was great to talk with you about bringing Turner Sparks to [Club Name] for a comedy night."
- Says "As I mentioned on the phone..." before key details
- Confirms show details discussed: 70-minute show (10-minute opener + Turner's 60-minute set)
${!isComedyClub ? '- Confirms the fee: $3,500 all-in — includes opener, Turner\'s fee, and all travel. No extras.' : '- Does NOT mention a specific dollar fee'}
- Briefly mentions credentials as a reminder: Sirius XM Comedy Roundup, Dry Bar Comedy special
- Name-drops 2–3 geographically relevant past clubs as a reminder of Turner's track record
- Offers a few available dates and invites them to suggest dates that work for the club calendar
- Mentions she has asked Turner to also send video clips
- Closes with something like "I look forward to confirming your date"
- Gives her phone number: 916-747-2718
- Signs off: "${myrnaSignOff}"`
      : `Written by Myrna Midkiff, Turner's mother and personal appearance manager, in first person as herself. She refers to Turner in third person.

MYRNA'S VOICE AND STYLE — follow this closely:
- Warm, personal, conversational — like a proud mom who also happens to be a sharp manager
- Opens with a friendly greeting using the contact's first name if known
- Introduces Turner as "a professional stand-up comedian based at the New York Comedy Club who performs comedy for private clubs throughout the country"
- Always mentions: his albums are played regularly on Sirius XM's Comedy Roundup channel, and his Dry Bar Comedy special
- Mentions he has had over 75 country club comedy shows — then name-drops 3–4 geographically relevant past clubs from the list provided (e.g. "Royal Oaks Country Club in Dallas, Colonial Country Club in Fort Worth, The Dominion Club in San Antonio")
- Describes the material as: "clean, hilarious, no politics — based on growing up in a country club, being a golfer, and the 12 years he lived in China where he opened China's first comedy club, Kung Fu Comedy Club in Shanghai"
- States the show format: 70 minutes — a 10-minute opener followed by Turner's 60-minute set
${!isComedyClub ? '- States the fee: $3,500 all-in — includes the opener, Turner\'s fee, and all travel expenses, no extras' : '- Does NOT mention a specific dollar fee'}
- Offers to check availability for dates that work on the club's calendar
- Mentions she has asked Turner to also send video clips of recent shows
- Closes warmly, gives her phone number: 916-747-2718, says she looks forward to confirming a date
- Signs off: "${myrnaSignOff}"`
    : isFollowUp
      ? `Written in first person by Turner Sparks himself, as a FOLLOW-UP EMAIL after he already spoke with this person by phone. Casual, warm, peer-to-peer comedian tone.

TURNER'S FOLLOW-UP STYLE:
- Opens with "Hey [Name]," or "Great talking with you [today / earlier this week], [Name] —"
- References the call naturally: "Just following up on our conversation about bringing a show to [Club Name]."
- Uses "As I mentioned..." to recap key points: the show format, his material (clean, no politics, country club life / golf / 12 years in China), Sirius XM, Dry Bar special
${!isComedyClub ? '- Reminds them of the fee: $3,500 all-in, no extras' : '- Does NOT mention a specific dollar fee'}
- Keeps it short and casual — this is a follow-up, not a full pitch
- Ends with a clear next step: "Happy to send over dates / answer any questions"
- Signs off: Turner Sparks`
      : `Written in first person by Turner Sparks himself. Signs off: Turner Sparks.`;
}

/* ── Step 1: Find clubs ─────────────────────────────────────────────────── */
app.post('/api/leads/step1', async (req, res) => {
  const { city, searchScope, clubType } = req.body;
  if (!city || !clubType) return res.status(400).json({ error: 'Missing city or clubType' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  const isComedyClub = clubType === 'comedy club';
  const prompt = isComedyClub
    ? `List up to 15 real, currently operating STANDUP COMEDY CLUBS (public venues that book standup headliners — NOT country clubs or private member clubs) in or near ${city} (${searchScope}). Exclude open-mic-only rooms and free showcase venues. Rank them #1 to #15 with the top result being the most prestigious, well-known, and established comedy club — rank by: national fame and reputation, capacity and production quality, history of booking major headliners, overall prestige in the comedy industry. For each club include a "budgetFit" field: one concise sentence describing why this club is reputable and worth pitching (e.g. "One of the most respected clubs in the country, regularly books nationally touring headliners"). Return ONLY a JSON array in ranked order: [{"clubName":"...","website":"...","address":"...","budgetFit":"..."}]. No other text.`
    : `List up to 15 real, currently operating ${clubType}s in or near ${city} (${searchScope}) that are financially capable of paying $3,500 for one night of private comedy entertainment. Exclude any clubs that appear budget-conscious, have small memberships, or are unlikely to spend on professional entertainment. Rank them #1 to #15 (most capable first) using: initiation fees, annual dues, estimated member count, prestige/exclusivity, and history of hosting paid entertainment events. For each club include a "budgetFit" field: one concise sentence (max 20 words) explaining why this club likely has the budget (e.g. "Initiation fees exceed $75,000 and the club hosts an annual black-tie gala with paid entertainment"). Return ONLY a JSON array in ranked order: [{"clubName":"...","website":"...","address":"...","budgetFit":"..."}]. No other text.`;

  try {
    console.log(`[Step 1] Finding ${clubType}s near ${city}...`);
    const r = await callAnthropic(prompt);
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: `Anthropic error: ${t}` }); }
    const d = await r.json();
    if (d.stop_reason === 'max_tokens') console.warn('[Step 1] Hit max_tokens');
    const clubs = parseJSON(d.content[0].text);
    console.log(`[Step 1] Done — found ${clubs.length} clubs`);
    res.json({ clubs });
  } catch (err) {
    console.error('Error in /api/leads/step1:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── Step 2: Enrich contacts ────────────────────────────────────────────── */
app.post('/api/leads/step2', async (req, res) => {
  const { clubs } = req.body;
  if (!clubs || !Array.isArray(clubs)) return res.status(400).json({ error: 'Missing clubs array' });

  try {
    console.log(`[Step 2] Enriching ${clubs.length} clubs via Hunter + scraping...`);
    const [hunterResults, scraped] = await Promise.all([
      Promise.all(clubs.map(c => hunterLookup(c.clubName, c.website))),
      Promise.all(clubs.map(c => scrapeContactInfo(c.website)))
    ]);
    const enriched = clubs.map((c, i) => ({
      ...c,
      contactName: hunterResults[i].name || null,
      contactTitle: hunterResults[i].title || null,
      contactEmail: hunterResults[i].email || scraped[i].email || null,
      contactPhone: scraped[i].phone || null
    }));
    console.log(`[Step 2] Done — ${enriched.filter(c => c.contactEmail).length}/${clubs.length} clubs have email`);
    res.json({ clubs: enriched });
  } catch (err) {
    console.error('Error in /api/leads/step2:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── Email: Generate one pitch email for one club ───────────────────────── */
app.post('/api/leads/email', async (req, res) => {
  const { club, clubType, eventFocus, sender, emailType, city } = req.body;
  if (!club) return res.status(400).json({ error: 'Missing club' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set.' });

  const isComedyClub = clubType === 'comedy club';
  const pastClubsList = PAST_CLUBS.map(c => `- ${c.name} (${c.city}, ${c.state}) — ${c.region}`).join('\n');
  const senderInstructions = buildSenderInstructions(sender, emailType, isComedyClub);

  const turnerCredentials = `Turner's credentials:
- Professional stand-up comedian based at the New York Comedy Club
- Performs comedy for private clubs and Invited Clubs throughout the country
- Over 75 country club comedy shows in recent years
- Comedy albums played regularly on Sirius XM radio, Comedy Roundup channel
- Comedy album "Double Happiness" (#1 on iTunes Comedy Charts): https://music.apple.com/us/album/double-happiness/id880195031
- Comedy album "Live From the Friars Club" (#2 on iTunes Comedy Charts): https://open.spotify.com/album/1BSUfw3aIa5kIpWuLKQEbR
- Dry Bar Comedy special "Buttoned Up and Unhinged" (Dry Bar has 11M+ subscribers)
- YouTube channel (stand-up clips): https://www.youtube.com/@TurnerSparks
- Website: https://www.turnersparks.com
Show format: 70 minutes total — 10-minute opener followed by Turner's 60-minute headlining set.
${!isComedyClub ? 'Performance fee: $3,500 all-in. Includes opener, Turner\'s fee, and all travel expenses. No extras, no surprises.' : ''}
Turner's material: Clean comedy, no politics. Material based on growing up in a country club, being a golfer, and the 12 years he lived in China where he opened China's first comedy club, Kung Fu Comedy Club in Shanghai.`;

  const sharedLinks = `Include 2–3 of the following as natural "sample my work" links:
• YouTube: https://www.youtube.com/@TurnerSparks
• "Double Happiness" album (#1 iTunes Comedy): https://music.apple.com/us/album/double-happiness/id880195031
• "Live From the Friars Club" (#2 iTunes Comedy): https://open.spotify.com/album/1BSUfw3aIa5kIpWuLKQEbR
• Dry Bar special "Buttoned Up and Unhinged" (mention as sign of his rising profile)
• Website: https://www.turnersparks.com`;

  const clubInfo = `Club: ${club.clubName}
Website: ${club.website || 'unknown'}
Address: ${club.address || 'unknown'}
Budget Fit: ${club.budgetFit || 'unknown'}
Contact name (from Hunter): ${club.contactName || 'none found'}
Contact title (from Hunter): ${club.contactTitle || 'none found'}
Email: ${club.contactEmail || 'none found'}
Phone: ${club.contactPhone || 'none found'}`;

  const contactRules = `IMPORTANT — contact data rules:
- Use the "Contact name" exactly as given if one was found; otherwise use "Events Department" (for clubs) or "Booking Department" (for comedy clubs).
- Use the "Contact title" exactly as given if one was found; otherwise infer an appropriate title.
- Use the "Email" exactly as given if one was found; otherwise use your best knowledge of a publicly available contact email, or "Email not found" as a last resort.
- For the phone number, always use the club's main reception/front desk line — never a personal direct line. Use the "Phone" value if it appears to be the main line; otherwise use your best knowledge of the venue's publicly listed main phone number, or "Phone not found" as a last resort.
- Address the pitch email to the contact name if known, otherwise use a general greeting.`;

  const prompt = isComedyClub
    ? `You are helping comedian Turner Sparks pitch a standup comedy club.
${turnerCredentials}

${contactRules}

${clubInfo}

${senderInstructions}

The pitch email must:
- Be friendly, direct, collegial — comedian-to-venue tone, peer to peer
- Reference the venue by name
- DO NOT mention any dollar figure or performance fee
- ${sharedLinks}
- Mention Turner's NYC base (headlines at NY Comedy Club, West Side Comedy Club, Stand Up NY)
- Focus on getting a booking conversation started

Also write a "clubDescription": one sentence about what makes this venue notable for booking comedy.

Return ONLY a single JSON object (not an array):
{"clubName":"...","contactName":"...","contactTitle":"...","contactEmail":"...","phone":"...","website":"...","budgetFit":"...","clubDescription":"...","pitchEmail":"..."}`
    : `You are helping comedian Turner Sparks pitch a ${clubType}.
${turnerCredentials}
Past club performances: ${pastClubsList}

${contactRules}

${clubInfo}

${senderInstructions}

The pitch email must:
- Be charming, warm, professional — never generic
- Reference the specific club and event focus: ${eventFocus}
- If event focus is "country club comedy night": frame it as a dinner-and-a-show the club sells to members — Turner performs, members buy tickets, self-funding member event. Turnkey, low-risk, proven.
- ${sharedLinks}
- If any past clubs are geographically near ${city}, name-drop them as social proof

Also write a "clubDescription": one sentence about what makes this club notable or well-suited for comedy.

Return ONLY a single JSON object (not an array):
{"clubName":"...","contactName":"...","contactTitle":"...","contactEmail":"...","phone":"...","website":"...","budgetFit":"...","clubDescription":"...","pitchEmail":"..."}`;

  try {
    console.log(`[Email] Generating email for ${club.clubName}...`);
    const r = await callAnthropic(prompt, 2048);
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: `Anthropic error: ${t}` }); }
    const d = await r.json();
    const text = d.content[0].text;
    // Parse either a single object or a single-element array
    let lead;
    try { lead = JSON.parse(text); } catch (_) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) lead = JSON.parse(m[0]);
      else { console.error('[Email] Parse failed:', text.slice(0, 400)); return res.status(500).json({ error: 'Could not parse email from AI response' }); }
    }
    if (Array.isArray(lead)) lead = lead[0];
    console.log(`[Email] Done — ${club.clubName}`);
    res.json({ lead });
  } catch (err) {
    console.error(`[Email] Error for ${club.clubName}:`, err);
    res.status(500).json({ error: err.message });
  }
});

const cmaaChapters = [
  { chapter: 'Alabama', director: 'John Grigsby', states: ['Alabama', 'Florida'], website: 'http://www.alcmaa.org/', email: null },
  { chapter: 'Aloha State', director: 'Wesley Wailehua', states: ['Hawaii'], website: 'http://www.cmaaaloha.com/', email: 'wwailehua@pgahq.com' },
  { chapter: 'Arkansas Razorback', director: 'Catie Pena', states: ['Arkansas'], website: 'http://www.cmaarazorback.org/', email: null },
  { chapter: 'Carolinas', director: 'Kate Scott', states: ['North Carolina', 'South Carolina'], website: 'http://www.carolinascmaa.org/', email: 'kate@carolinascmaa.org' },
  { chapter: 'Central Pennsylvania', director: 'Jennifer Mang, CCM', states: ['Pennsylvania'], website: 'http://www.cmaacpa.com/', email: 'jmang@cmaacpa.com' },
  { chapter: 'City of New York', director: 'John Samayoa, CCM', states: ['New York'], website: null, email: null },
  { chapter: 'Connecticut', director: 'Sally Becker, CCM', states: ['Connecticut'], website: 'http://www.cmaact.org/', email: null },
  { chapter: 'Evergreen', director: 'Eddy Carrell', states: ['Washington', 'Idaho', 'Montana'], website: 'http://www.evergreencmaa.org/', email: null },
  { chapter: 'Florida', director: 'Kelly Grabowsky', states: ['Florida'], website: 'http://www.flcmaa.org/', email: 'kelly@flcmaa.org' },
  { chapter: 'Georgia', director: 'Allegra Johnson', states: ['Georgia'], website: 'http://www.gacmaa.org/', email: 'allegra@gacmaa.org' },
  { chapter: 'Golden State', director: 'Lindsay Pizarro', states: ['California'], website: 'http://www.thegsc.org/', email: 'md@thegsc.org' },
  { chapter: 'Greater Cleveland', director: 'Kimberly Viola', states: ['Ohio', 'Pennsylvania'], website: 'http://www.gccmaa.org/', email: 'ClevelandCMAA@gmail.com' },
  { chapter: 'Greater Illinois', director: 'Kathryn A. Collins', states: ['Illinois', 'Indiana'], website: 'http://www.greaterchicagocmaa.org/', email: 'kcollins@wi-il-cmaa.org' },
  { chapter: 'Greater Michigan', director: 'Tammy Carter', states: ['Michigan'], website: 'http://www.gmcma.cc/', email: 'gmcmaa@gmail.com' },
  { chapter: 'Greater Southwest', director: 'Gaby Speh', states: ['Arizona', 'Nevada', 'New Mexico'], website: 'http://www.greatersouthwestcmaa.org/', email: 'gaby@greatersouthwestcmaa.org' },
  { chapter: 'Iowa Tall Corn', director: 'Hanah Litz', states: ['Iowa'], website: 'https://www.iowacmaa.org/', email: null },
  { chapter: 'Metropolitan', director: 'Heather Apgar', states: ['New York'], website: 'http://www.metcma.org/', email: 'hapgar@metcma.org' },
  { chapter: 'Middle Atlantic', director: 'Kate McCabe', states: ['Washington DC', 'Maryland', 'Virginia', 'West Virginia'], website: 'https://macmaa.net/', email: null },
  { chapter: 'Mid-America', director: 'Sara Murray', states: ['Missouri', 'Kansas'], website: 'http://www.midamericacmaa.org/', email: null },
  { chapter: 'Mile High', director: 'Cortney Murphy', states: ['Colorado', 'Wyoming'], website: 'https://www.milehighcmaa.org/', email: 'cortney@milehighcmaa.org' },
  { chapter: 'Nebraska', director: 'Katy Boggs', states: ['Nebraska', 'Iowa'], website: null, email: 'katy@boggsmanagementco.com' },
  { chapter: 'New England', director: 'Laura Ryan', states: ['Maine', 'New Hampshire', 'Vermont', 'Massachusetts', 'Rhode Island'], website: 'http://www.necma.org/', email: 'Managing.Director@necma.org' },
  { chapter: 'New Jersey', director: 'Rosemary Panno', states: ['New Jersey'], website: 'http://www.njcma.org/', email: 'md@njcma.org' },
  { chapter: 'New York State', director: 'Brittany Feuz', states: ['New York', 'Pennsylvania'], website: 'http://www.nyscmaa.org/', email: 'managingdirector@nyscmaa.org' },
  { chapter: 'Ohio Valley', director: 'David Brown, CCM, CCE', states: ['Ohio', 'Indiana', 'Kentucky', 'West Virginia'], website: 'http://www.ovccmaa.org/', email: 'md2@ovccmaa.org' },
  { chapter: 'Oklahoma-Kansas', director: 'Sam B. Brewster', states: ['Oklahoma', 'Kansas'], website: 'http://www.okcmaa.org/', email: 'sam@texascmaa.org' },
  { chapter: 'Oregon', director: 'Susan R. Rogers', states: ['Oregon', 'Washington'], website: 'http://www.cmaaoregon.org/', email: 'srogers@evergreenclub.org' },
  { chapter: 'Pelican', director: 'Sam B. Brewster', states: ['Louisiana', 'Mississippi'], website: 'https://cmaapelican.com/', email: 'sam@texascmaa.org' },
  { chapter: 'Philadelphia and Vicinity', director: 'Kelly Beck', states: ['Delaware', 'New Jersey', 'Pennsylvania'], website: 'https://www.pvcma.org/', email: 'info@pvcma.org' },
  { chapter: 'Pittsburgh', director: 'Jeanne Davis, CCM', states: ['Pennsylvania', 'West Virginia'], website: 'http://www.pittcmaa.org/', email: 'jeanne@pittcmaa.org' },
  { chapter: 'St. Louis District', director: 'Laura Hodges', states: ['Missouri', 'Illinois'], website: 'http://www.cmaastlouis.com/', email: 'lhodges@cmaastlouis.com' },
  { chapter: 'Tennessee Volunteer', director: 'Dori Paschall', states: ['Tennessee'], website: 'http://cmaavol.com/', email: 'md@cmaavol.com' },
  { chapter: 'Texas Lone Star', director: 'Sam B. Brewster', states: ['Texas'], website: 'http://www.texascmaa.org/', email: 'sam@texascmaa.org' },
  { chapter: 'Upper Midwest', director: 'Rollie Carlson', states: ['Minnesota', 'North Dakota', 'South Dakota'], website: 'http://www.cmaa-uppermidwestchapter.org/', email: 'rollie@rolliecarlson.com' },
  { chapter: 'Utah', director: 'Cortney Murphy', states: ['Utah'], website: 'https://www.cmaautah.org/', email: 'cortney@milehighcmaa.org' },
  { chapter: 'Virginias', director: 'Kristi Fellenstein, CCM', states: ['Virginia', 'West Virginia'], website: 'http://www.virginiascmaa.org/', email: 'kristi@virginiascmaa.org' },
  { chapter: 'Wisconsin Badger', director: 'Kathryn A. Collins', states: ['Wisconsin'], website: 'http://www.wisconsincmaa.org/', email: 'kcollins@wi-il-cmaa.org' }
];

app.post('/api/cmaa-leads', async (req, res) => {
  const { state, sender } = req.body;
  const isMyrna = sender === 'myrna';

  if (!state) return res.status(400).json({ error: 'State is required.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY environment variable is not set.' });

  const matching = cmaaChapters.filter(c =>
    c.states.some(s => s.toLowerCase() === state.toLowerCase())
  );

  if (matching.length === 0) return res.json({ leads: [] });

  const chaptersInfo = matching.map(c =>
    `- Chapter: "${c.chapter}" | Managing Director: ${c.director} | States: ${c.states.join(', ')} | Website: ${c.website || 'N/A'}`
  ).join('\n');

  const cmaaSenderNote = isMyrna
    ? `The emails are written by Myrna Midkiff, Turner's mother and booking manager. She writes in the first person as herself, referring to Turner in the third person (e.g., "my client Turner Sparks", "Turner has performed at...", "I'd love to connect you with Turner"). She signs off as: Myrna Midkiff, Booking Manager for Turner Sparks. Her tone is warm, confident, and professional — a proud manager introducing her client.`
    : `Each email is written in the first person by Turner Sparks himself. He signs off as: Turner Sparks.`;

  const prompt = `You are helping comedian Turner Sparks introduce himself to CMAA (Club Managers Association of America) chapter managing directors. CMAA chapters represent club managers across the US — these directors are a powerful gateway to getting Turner booked at member clubs in their region.

Turner Sparks is the United States' premier country club comedian. He has performed at 75+ country clubs nationwide, specializes in a "dinner and a show" comedy night format that clubs sell to their members as a profitable, self-funding event, and brings clean, smart, sophisticated comedy perfect for private club audiences of all ages.

Turner's credentials:
- Website: https://www.turnersparks.com
- YouTube channel (live clips): https://www.youtube.com/@TurnerSparks
- "Double Happiness" comedy album — hit #1 on iTunes Comedy Charts: https://music.apple.com/us/album/double-happiness/id880195031
- "Live From the Friars Club" — hit #2 on iTunes Comedy Charts: https://open.spotify.com/album/1BSUfw3aIa5kIpWuLKQEbR
- Upcoming Dry Bar Comedy special "Buttoned Up and Unhinged" (Dry Bar has 11M+ subscribers)

${cmaaSenderNote}

Write a personalized pitch email to each of the following CMAA chapter managing directors:
${chaptersInfo}

Each email should:
- Address the director warmly by first name
- Reference their specific chapter name and the region/states it covers
- Introduce Turner as the country's top country club comedian and explain the "dinner and a show" model — the club sells tickets to a dinner + comedy night, Turner is the featured entertainment, and it becomes a fun, self-funding member event
- Mention that ${isMyrna ? 'she' : 'he'}'d love to be a resource the director can refer to member clubs in their region when those clubs are looking for quality entertainment
- Include 1–2 credential links naturally (vary which ones you use across emails)
- Be warm, brief, and professional — not overly long, not salesy

Return a JSON array with one object per chapter, in the same order as listed above:
[{ "chapterName": "...", "pitchEmail": "..." }]

Return ONLY the JSON array, no other text.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `Anthropic API error: ${errText}` });
    }

    const data = await response.json();
    const content = data.content[0].text;

    let emailResults;
    try {
      emailResults = JSON.parse(content);
    } catch (e) {
      const match = content.match(/\[[\s\S]*\]/);
      if (match) emailResults = JSON.parse(match[0]);
      else return res.status(500).json({ error: 'Failed to parse response from AI.' });
    }

    const emailMap = {};
    emailResults.forEach(r => { emailMap[r.chapterName] = r.pitchEmail; });

    const leads = matching.map(c => ({
      chapterName: c.chapter,
      directorName: c.director,
      states: c.states.join(', '),
      website: c.website || null,
      email: c.email || null,
      pitchEmail: emailMap[c.chapter] || ''
    }));

    res.json({ leads });
  } catch (err) {
    console.error('Error calling Anthropic API:', err);
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Turner Sparks Lead Generator running on port ${PORT}`);
});

/* Graceful shutdown — let in-flight requests finish before exiting */
process.on('SIGTERM', () => {
  console.log('SIGTERM received — waiting for in-flight requests to finish...');
  server.close(() => {
    pool.end(() => {
      console.log('Server shut down gracefully.');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  server.close(() => pool.end(() => process.exit(0)));
});

/* Prevent unhandled rejections / exceptions from crashing the process */
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
