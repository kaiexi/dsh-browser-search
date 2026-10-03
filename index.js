/**
 * dsh-browser-search — a DSH cordis plugin that exposes a `browser_search` tool.
 *
 * The tool drives a dedicated local Edge/Chromium instance over CDP (its own
 * user-data-dir, headless by default), so results render exactly as a real
 * browser renders them — independent of the built-in web_search provider.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { search, ENGINE_NAMES } from './lib/search.js';

/** Stable Loader identity. */
export const name = 'dsh-browser-search';

/** Services used by the browser search tool. */
export const inject = ['tools'];

/**
 * Record a successful registration so a reload can be verified from outside the
 * process. Best-effort: a failure here must never stop the tool registering.
 */
function writeStatus(entry) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const target =
      process.env.DSH_BROWSER_SEARCH_STATUS || path.join(home, 'dsh-browser-search.status.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `${JSON.stringify({ ...entry, pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`
    );
  } catch {
    /* diagnostics only */
  }
}

function formatResults(value) {
  const lines = [`${value.engine} · "${value.query}" — ${value.results.length} result(s)`];
  value.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`, `   ${result.url}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
  });
  return lines.join('\n');
}

/**
 * Register the browser-backed web search tool.
 * @param ctx - agent-scoped services.
 */
export function apply(ctx) {
  const tool = defineTool({
    name: 'browser_search',
    description:
      'Search the web with a real local browser tab (Edge/Chromium over CDP) and return ranked results with title, URL, and snippet. Use this instead of the built-in web_search when that provider is unavailable, erroring, rate-limited, or returning poor results, and when you need results exactly as a real browser renders them.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The search query. Natural language or keywords both work.',
      },
      count: {
        type: 'number',
        description: 'Maximum number of results to return (1-50, default 8).',
      },
      engine: {
        type: 'string',
        description: `Search engine to use: ${ENGINE_NAMES.join(', ')} (default bing).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          engine: { type: 'string', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
                snippet: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatResults(value) }],
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted?.();
      const outcome = await search(args.query, {
        count: args.count,
        engine: args.engine,
        signal: exec.signal,
      });
      exec.signal?.throwIfAborted?.();
      if (outcome.results.length === 0) {
        const tried = `${outcome.attemptedUrls?.length ?? 1} URL(s)`;
        throw new Error(
          outcome.noResults
            ? `${outcome.engineLabel} reports no results for "${args.query}". ` +
                'Rephrase the query with different keywords, or pass a different engine.'
            : outcome.blocked
              ? `${outcome.engineLabel} served a captcha or consent page for "${args.query}" ` +
                  `(final URL: ${outcome.finalUrl}). Retry later, or pass a different engine.`
              : outcome.error
                ? `browser_search("${args.query}") could not read ${outcome.engineLabel} results: ${outcome.error}`
                : `browser_search("${args.query}") extracted no results from ${outcome.engineLabel} ` +
                    `after trying ${tried}; the page layout was not recognised. ` +
                    'Retry, or pass a different engine.'
        );
      }
      return {
        query: outcome.query,
        engine: outcome.engineLabel,
        results: outcome.results.map((result) => ({
          title: result.title,
          url: result.url,
          snippet: result.snippet || '',
        })),
      };
    },
  });

  ctx.tools.register(tool);
  writeStatus({ plugin: name, tool: tool.name, engines: ENGINE_NAMES });
}
