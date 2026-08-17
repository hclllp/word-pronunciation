import { DurableObject } from "cloudflare:workers";

const STATS_NAME = "global";
const SINGAPORE_TZ = "Asia/Singapore";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/stats') {
      const stub = env.API_STATS.getByName(STATS_NAME);
      const response = await stub.fetch(new Request('https://stats.local/read'));
      return new Response(response.body, {
        status: response.status,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    if (url.pathname !== '/lookup') {
      return json({ error: 'Not found' }, 404);
    }

    const word = (url.searchParams.get('word') || '').trim();
    if (!word || !/^[A-Za-z][A-Za-z' -]*$/.test(word)) {
      return json({ error: 'Invalid word' }, 400);
    }

    const encoded = encodeURIComponent(word);
    const dictionaryUrl = `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encoded}?key=${encodeURIComponent(env.MW_DICTIONARY_KEY)}`;
    const schoolUrl = `https://www.dictionaryapi.com/api/v3/references/sd4/json/${encoded}?key=${encodeURIComponent(env.MW_SCHOOL_KEY)}`;
    const stats = env.API_STATS.getByName(STATS_NAME);

    try {
      await stats.fetch(new Request('https://stats.local/record', {
        method: 'POST',
        body: JSON.stringify({ api: 'dictionary' })
      }));

      let response = await fetch(dictionaryUrl, { cf: { cacheTtl: 0, cacheEverything: false } });
      let data = await response.json();
      if (!response.ok) return json({ error: 'Merriam-Webster request failed', status: response.status }, response.status);

      let source = 'collegiate';
      if (!Array.isArray(data) || !data.length || typeof data[0] === 'string') {
        await stats.fetch(new Request('https://stats.local/record', {
          method: 'POST',
          body: JSON.stringify({ api: 'school' })
        }));
        response = await fetch(schoolUrl, { cf: { cacheTtl: 0, cacheEverything: false } });
        data = await response.json();
        source = 'school';
      }
      if (!Array.isArray(data) || !data.length || typeof data[0] === 'string') {
        return json({ error: 'Word not found', suggestions: Array.isArray(data) ? data.slice(0, 8) : [] }, 404);
      }

      return json({ source, entries: data.slice(0, 4) });
    } catch (error) {
      return json({ error: 'Upstream request failed' }, 502);
    }
  }
};

export class ApiStats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const stats = await this.ctx.storage.get('today');
      if (!stats) {
        await this.resetForToday();
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.ensureToday();

    if (url.pathname === '/record' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      if (body.api !== 'dictionary' && body.api !== 'school') {
        return new Response('bad api', { status: 400 });
      }
      const stats = await this.ctx.storage.get('today');
      const hour = singaporeHour();
      stats[body.api] += 1;
      stats.hourly[hour][body.api] += 1;
      await this.ctx.storage.put('today', stats);
      return jsonInternal({ ok: true });
    }

    if (url.pathname === '/read' && request.method === 'GET') {
      const stats = await this.ctx.storage.get('today');
      return jsonInternal({
        date: stats.date,
        timezone: SINGAPORE_TZ,
        dictionary: stats.dictionary,
        school: stats.school,
        total: stats.dictionary + stats.school,
        hourly: stats.hourly
      });
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm() {
    await this.resetForToday();
  }

  async ensureToday() {
    const current = singaporeDate();
    const stats = await this.ctx.storage.get('today');
    if (!stats || stats.date !== current) await this.resetForToday();
  }

  async resetForToday() {
    const hourly = {};
    for (let h = 0; h < 24; h++) {
      const key = String(h).padStart(2, '0');
      hourly[key] = { dictionary: 0, school: 0 };
    }
    await this.ctx.storage.put('today', {
      date: singaporeDate(),
      dictionary: 0,
      school: 0,
      hourly
    });
    await this.ctx.storage.setAlarm(nextSingaporeMidnight());
  }
}

function singaporeDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SINGAPORE_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function singaporeHour() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SINGAPORE_TZ,
    hour: '2-digit', hour12: false
  }).formatToParts(new Date());
  return parts.find(p => p.type === 'hour')?.value || '00';
}

function nextSingaporeMidnight() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SINGAPORE_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const day = Number(parts.find(p => p.type === 'day').value);
  return Date.UTC(year, month - 1, day + 1, 0, 0, 0) - 8 * 60 * 60 * 1000;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' }
  });
}
function jsonInternal(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
