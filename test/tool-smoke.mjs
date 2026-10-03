/**
 * Standalone harness: load the plugin exactly as the DSH loader would, register its
 * tool against a stub `ctx.tools`, then exercise validation + execute + render.
 * Run: node test/tool-smoke.mjs
 */

import { apply, name, inject } from '../index.js';

const registered = [];
const ctx = {
  tools: {
    register(tool) {
      registered.push(tool);
    },
  },
};

console.log('plugin name   :', name);
console.log('plugin inject :', JSON.stringify(inject));

apply(ctx);

if (registered.length !== 1) throw new Error(`expected 1 registered tool, got ${registered.length}`);
const tool = registered[0];

console.log('tool keys     :', Object.keys(tool).sort().join(', '));
console.log('tool name     :', tool.name);
console.log('parameters    :', JSON.stringify(tool.parameters ?? tool.parametersSchema ?? null, null, 2));
console.log('output schema :', JSON.stringify(tool.output?.schema ?? null, null, 2));

const args = { query: process.argv[2] || 'DeepSeek Harness', count: 3 };
const exec = { signal: new AbortController().signal };

const started = Date.now();
const value = await tool.execute(args, exec);
console.log(`\nexecute() ok in ${Date.now() - started} ms`);
console.log('returned keys :', Object.keys(value).join(', '));

const rendered = tool.output.render(args, value);
console.log('\n--- rendered to model ---');
for (const block of rendered) console.log(block.text);
