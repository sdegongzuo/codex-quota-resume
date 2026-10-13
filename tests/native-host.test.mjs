import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startNativeHost } from '../scripts/native-host.mjs';

test('stdio host starts one isolated backend and preserves JSON routing and exit code', async () => {
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const script = "const r=require('node:readline').createInterface({input:process.stdin});r.on('line',l=>{const m=JSON.parse(l);process.stdout.write(JSON.stringify({id:m.id,result:{echo:m.params}})+'\\n')});r.on('close',()=>{process.exitCode=7})";
  const host = startNativeHost({ executable: process.execPath, args: ['-e', script],
    input, output, errorOutput: errors });
  input.end(JSON.stringify({ id: 88, method: 'test', params: { value: 'synthetic' } }) + '\n');
  const result = await host.completion;
  assert.equal(result.code, 7);
  assert.deepEqual(JSON.parse(text.trim()), { id: 88, result: { echo: { value: 'synthetic' } } });
});

test('relative original CLI is refused before launching a child', () => {
  assert.throws(() => startNativeHost({ executable: 'codex.exe', args: [] }), /absolute path/);
});
