/**
 * Scopos demo server (Cloudflare Worker).
 *
 * Holds one Anthropic API key as a secret so people can try the extension
 * without a key of their own. It never forwards what the client sends: it
 * builds each request itself from the Scopos prompt and step schema, taking
 * only the model and the page text from the client. It also limits how often
 * one network can call it. The real budget cap is the spend limit on the
 * key's Anthropic workspace.
 */
import '../chrome-extension/prompt.js';

const { system: SYSTEM_PROMPT, schema: STEPS_SCHEMA } = globalThis.SCOPOS_PROMPT;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const EFFORTS = new Set(['low', 'medium', 'high']);
const MAX_TOKENS = 16000;
const MAX_BODY_BYTES = 256 * 1024;
// 400 page elements at ~120 characters each, plus the goal.
const MAX_CONTENT_CHARS = 60000;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/v1/messages') return apiError(404, 'not_found_error', 'Not found.');
    if (request.method !== 'POST') return apiError(405, 'invalid_request_error', 'Use POST.');
    if (!env.ANTHROPIC_API_KEY) return apiError(500, 'api_error', 'The demo server has no API key set up yet.');

    if (env.LIMITER) {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) {
        return apiError(429, 'rate_limit_error', 'Too many requests from this network. Wait a minute and try again.');
      }
    }

    // Turn away oversized bodies before reading them; the length check below covers chunked uploads.
    if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
      return apiError(413, 'request_too_large', 'This page is too big for the demo server.');
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return apiError(413, 'request_too_large', 'This page is too big for the demo server.');
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return apiError(400, 'invalid_request_error', 'The request body must be JSON.');
    }
    const problem = checkBody(body);
    if (problem) return apiError(400, 'invalid_request_error', problem);

    const headers = {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    const upstreamBody = {
      model: body.model,
      max_tokens: body.max_tokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: body.messages[0].content }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: EFFORTS.has(body.output_config?.effort) ? body.output_config.effort : 'medium',
        format: { type: 'json_schema', schema: STEPS_SCHEMA },
      },
    };
    if (FALLBACK_MODELS.has(body.model)) {
      headers['anthropic-beta'] = FALLBACK_BETA;
      upstreamBody.fallbacks = 'default';
    }

    let upstream;
    try {
      upstream = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(upstreamBody) });
    } catch {
      return apiError(502, 'api_error', 'The demo server could not reach Anthropic.');
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
    });
  },
};

/**
 * Only the model, max_tokens and the page text come from the client; the
 * prompt, schema and every other field are fixed above, so the key can't be
 * used as a general-purpose Claude endpoint.
 */
function checkBody(body) {
  const notScopos = 'This demo server only answers Scopos step requests.';
  if (!body || typeof body !== 'object' || Array.isArray(body)) return notScopos;
  if (!MODELS.has(body.model)) return 'This demo server only runs Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5.';
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > MAX_TOKENS) {
    return `max_tokens must be between 1 and ${MAX_TOKENS}.`;
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.role !== 'user') return notScopos;
  const content = messages[0].content;
  if (typeof content !== 'string' || !content.startsWith('page title:')) return notScopos;
  if (content.length > MAX_CONTENT_CHARS) return 'This page is too big for the demo server.';
  return null;
}

// Errors use Anthropic's own shape, so the extension reads them like API errors.
function apiError(status, type, message) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
