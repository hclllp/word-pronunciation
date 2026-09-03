import { DurableObject } from "cloudflare:workers";

const STATS_NAME = "global";
const SINGAPORE_TZ = "Asia/Singapore";
const MAIL_ENDPOINT = "https://dedicated-meeting-que-ips.trycloudflare.com/mail/send";
const ALERT_THRESHOLD = 800;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (url.pathname === '/stats') {
      try {
        const stub = env.API_STATS.getByName(STATS_NAME);
        const response = await stub.fetch(new Request('https://stats.local/read'));
        return new Response(response.body, { status: response.status, headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
      } catch (error) { console.error('Stats read failed:', error); return json({ error: 'Stats service unavailable' }, 503); }
    }
    if (url.pathname !== '/lookup') return json({ error: 'Not found' }, 404);
    const word = (url.searchParams.get('word') || '').trim();
    if (!word || !/^[A-Za-z][A-Za-z' -]*$/.test(word)) return json({ error: 'Invalid word' }, 400);
    const encoded = encodeURIComponent(word);
    const dictionaryUrl = `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encoded}?key=${encodeURIComponent(env.MW_DICTIONARY_KEY)}`;
    const schoolUrl = `https://www.dictionaryapi.com/api/v3/references/sd4/json/${encoded}?key=${encodeURIComponent(env.MW_SCHOOL_KEY)}`;
    try {
      let dictionaryCalled = false, schoolCalled = false, data = null, source = null;
      try {
        dictionaryCalled = true;
        const response = await fetch(dictionaryUrl, { cf: { cacheTtl: 0, cacheEverything: false } });
        if (response.ok) {
          const candidate = await response.json();
          if (hasUsableEntry(candidate)) { data = candidate; source = 'collegiate'; }
        } else console.warn('Dictionary API returned HTTP', response.status, 'for', word);
      } catch (error) { console.warn('Dictionary API request failed for', word, error); }
      if (!data) {
        try {
          schoolCalled = true;
          const response = await fetch(schoolUrl, { cf: { cacheTtl: 0, cacheEverything: false } });
          if (response.ok) {
            const candidate = await response.json();
            if (hasUsableEntry(candidate)) { data = candidate; source = 'school'; }
          } else console.warn('School Dictionary API returned HTTP', response.status, 'for', word);
        } catch (error) { console.warn('School Dictionary API request failed for', word, error); }
      }
      const usedApis = [];
      if (dictionaryCalled) usedApis.push('dictionary');
      if (schoolCalled) usedApis.push('school');
      if (usedApis.length) recordUsageAfterLookup(ctx, env, usedApis);
      if (!data) return json({ error: 'Word not found', suggestions: [] }, 404);
      const entries = data.slice(0, 4).map(entry => source === 'collegiate' ? normalizeCollegiateEntry(entry) : entry);
      return json({ source, entries });
    } catch (error) { console.error('Lookup failed:', error); return json({ error: 'Upstream request failed' }, 502); }
  }
};

function hasUsableEntry(data) {
  if (!Array.isArray(data) || !data.length) return false;
  return data.some(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (Array.isArray(entry.def) && entry.def.length) return true;
    if (Array.isArray(entry.shortdef) && entry.shortdef.some(x => String(x || '').trim())) return true;
    return false;
  });
}

// The Collegiate API has the same general MW hierarchy as School Dictionary,
// but the frontend historically expects usable definition text under def/sseq.
// Normalize Collegiate shortdef into that common shape so the UI cannot lose a
// valid definition merely because the two reference works expose different
// useful fields.
function normalizeCollegiateEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (Array.isArray(entry.shortdef) && entry.shortdef.length) {
    const normalized = entry.shortdef.map(text => String(text || '').trim()).filter(Boolean).map(text => [
      'sense',
      { dt: [['text', text]] }
    ]);
    if (normalized.length) {
      return { ...entry, def: [{ sseq: [normalized] }] };
    }
  }
  return entry;
}

function recordUsageAfterLookup(ctx, env, apis) {
  try {
    const stats = env.API_STATS.getByName(STATS_NAME);
    for (const api of apis) ctx.waitUntil(stats.fetch(new Request('https://stats.local/record', { method: 'POST', body: JSON.stringify({ api }) })).catch(error => console.error(`${api} stats recording failed:`, error)));
  } catch (error) { console.error('Stats binding unavailable:', error); }
}

export class ApiStats extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx.blockConcurrencyWhile(async () => { const stats = await this.ctx.storage.get('today'); if (!stats) await this.resetForToday(); }); }
  async fetch(request) {
    const url = new URL(request.url); await this.ensureToday();
    if (url.pathname === '/record' && request.method === 'POST') {
      let body; try { body = await request.json(); } catch { body = {}; }
      if (body.api !== 'dictionary' && body.api !== 'school') return new Response('bad api', { status: 400 });
      const stats = await this.ctx.storage.get('today'), hour = singaporeHour(); stats[body.api] += 1; stats.hourly[hour][body.api] += 1;
      const alertKey = `${body.api}AlertSent`, shouldAlert = stats[body.api] >= ALERT_THRESHOLD && !stats[alertKey]; if (shouldAlert) stats[alertKey] = true;
      await this.ctx.storage.put('today', stats); if (shouldAlert) await sendQuotaAlert(body.api, stats[body.api], stats.date); return jsonInternal({ ok: true });
    }
    if (url.pathname === '/read' && request.method === 'GET') { const stats = await this.ctx.storage.get('today'); return jsonInternal({ date: stats.date, timezone: SINGAPORE_TZ, dictionary: stats.dictionary, school: stats.school, total: stats.dictionary + stats.school, hourly: stats.hourly }); }
    return new Response('Not found', { status: 404 });
  }
  async alarm() { await this.resetForToday(); }
  async ensureToday() { const current = singaporeDate(), stats = await this.ctx.storage.get('today'); if (!stats || stats.date !== current) await this.resetForToday(); }
  async resetForToday() { const hourly = {}; for (let h = 0; h < 24; h++) hourly[String(h).padStart(2, '0')] = { dictionary: 0, school: 0 }; await this.ctx.storage.put('today', { date: singaporeDate(), dictionary: 0, school: 0, dictionaryAlertSent: false, schoolAlertSent: false, hourly }); await this.ctx.storage.setAlarm(nextSingaporeMidnight()); }
}

async function sendQuotaAlert(api, count, date) { const apiName = api === 'dictionary' ? 'Dictionary API' : 'School Dictionary API'; const subject = `${apiName} daily request alert`; const body = `${apiName} has reached ${count} requests today (${date}, Asia/Singapore). The alert threshold is ${ALERT_THRESHOLD}.`; const url = `${MAIL_ENDPOINT}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`; try { const response = await fetch(url, { method: 'GET' }); if (!response.ok) console.error('Quota alert mail failed with HTTP', response.status); else { const result = await response.json().catch(() => null); if (!result?.ok) console.error('Quota alert mail failed:', result?.error || 'unknown error'); } } catch (error) { console.error('Quota alert mail request failed:', error); } }
function singaporeDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: SINGAPORE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function singaporeHour() { const parts = new Intl.DateTimeFormat('en-GB', { timeZone: SINGAPORE_TZ, hour: '2-digit', hour12: false }).formatToParts(new Date()); return parts.find(p => p.type === 'hour')?.value || '00'; }
function nextSingaporeMidnight() { const now = new Date(), parts = new Intl.DateTimeFormat('en-CA', { timeZone: SINGAPORE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now), year = Number(parts.find(p => p.type === 'year').value), month = Number(parts.find(p => p.type === 'month').value), day = Number(parts.find(p => p.type === 'day').value); return Date.UTC(year, month - 1, day + 1, 0, 0, 0) - 8 * 60 * 60 * 1000; }
function corsHeaders() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' }; }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' } }); }
function jsonInternal(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }