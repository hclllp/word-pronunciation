export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
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

    try {
      let response = await fetch(dictionaryUrl);
      let data = await response.json();
      if (!response.ok) return json({ error: 'Merriam-Webster request failed', status: response.status }, response.status);

      // Collegiate returns an array of entry objects for a successful headword.
      // A short array of strings means spelling suggestions/no exact entry.
      let source = 'collegiate';
      if (!Array.isArray(data) || !data.length || typeof data[0] === 'string') {
        response = await fetch(schoolUrl);
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=3600'
  };
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' }
  });
}
