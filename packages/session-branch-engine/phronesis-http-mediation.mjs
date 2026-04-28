export function createHttpPhronesisMediation(options = {}) {
  const baseUrl = (options.baseUrl || process.env.PHRONESIS_API_BASE || 'http://127.0.0.1:8788').replace(/\/$/, '');
  const apiKey = options.apiKey || process.env.PHRONESIS_API_KEY || '';

  function headers() {
    const h = { 'content-type': 'application/json' };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  }

  async function post(path, body) {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Phronesis API ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  async function get(path) {
    const res = await fetch(baseUrl + path, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (!res.ok) {
      throw new Error(`Phronesis API ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  return {
    async ingestTurnSummary(input) {
      return post('/compiler/extract', { input_type: 'turn_summary', input });
    },
    async buildRecallSet(request) {
      const q = encodeURIComponent(request?.objective ?? request?.query ?? '');
      const sessionKey = request?.sessionKey ? `&sessionKey=${encodeURIComponent(request.sessionKey)}` : '';
      const limit = request?.limit ? `&limit=${encodeURIComponent(String(request.limit))}` : '';
      const result = await get(`/recall?objective=${q}${sessionKey}${limit}`);
      return { items: result.items ?? [] };
    },
    async proposePatch(input) {
      return post('/merge/review-decisions', input);
    },
  };
}
