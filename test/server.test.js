// Unit tests for the pure, load-bearing helpers in server.js.
// Run: npm test   (uses the built-in node:test runner, no dependencies)
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const { cwdToProjectDir, isTempCwd, truncStr, renderable, slim } = require('../server.js');

test('cwdToProjectDir escapes EVERY non-alphanumeric char and keeps leading dashes', () => {
  // This must match Claude Code's own escaping exactly — an earlier bug only
  // replaced :\/ and stripped leading dashes, silently breaking _ / . / VM paths.
  assert.equal(cwdToProjectDir('C:\\a_b'), 'C--a-b');
  assert.equal(cwdToProjectDir('/sessions/x'), '-sessions-x');           // leading dash KEPT
  assert.equal(cwdToProjectDir('C:\\Users\\ak020\\my.proj'), 'C--Users-ak020-my-proj');
  assert.equal(cwdToProjectDir('/home/u/a-b_c.d'), '-home-u-a-b-c-d');
  assert.equal(cwdToProjectDir('abc123'), 'abc123');                     // alphanumerics untouched
});

test('isTempCwd matches the OS temp dir and its project-dir escaping, with a real boundary', () => {
  const tmp = os.tmpdir();
  assert.equal(isTempCwd(path.join(tmp, 'cc-test-123'), null), true);
  assert.equal(isTempCwd(tmp, null), true);                              // the dir itself
  assert.equal(isTempCwd('C:\\Users\\ak020\\Desktop\\project', null), false);
  // escaped project-dir name form (what scanCodeHistory sees before reading cwd)
  assert.equal(isTempCwd(null, cwdToProjectDir(tmp) + '-cc-abc'), true);
  assert.equal(isTempCwd(null, 'C--Users-ak020-Desktop-real'), false);
  // boundary: a sibling dir sharing the temp prefix must NOT count as temp
  assert.equal(isTempCwd(tmp + '-evil', null), false);
});

test('truncStr caps long strings and leaves short ones / non-strings alone', () => {
  assert.equal(truncStr('short', 4000), 'short');
  const long = 'x'.repeat(5000);
  const out = truncStr(long, 4000);
  assert.ok(out.length < 5000 && out.endsWith('… [truncated]'));
  assert.equal(truncStr(42, 10), 42);          // non-string passthrough
  assert.equal(truncStr(null, 10), null);
});

test('renderable keeps only user/assistant/result events', () => {
  assert.equal(renderable({ type: 'user' }), true);
  assert.equal(renderable({ type: 'assistant' }), true);
  assert.equal(renderable({ type: 'result' }), true);
  assert.equal(renderable({ type: 'queue-operation' }), false);
  assert.equal(renderable({ type: 'system' }), false);
  assert.ok(!renderable(null));   // returns a falsy value (not strictly false)
});

test('slim drops thinking/tool_result blocks and truncates big tool inputs', () => {
  const ev = {
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: 'secret reasoning' },
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'Write', input: { file_path: 'x', content: 'y'.repeat(9000) } },
    ] },
  };
  const out = slim(ev);
  const types = out.message.content.map(b => b.type);
  assert.deepEqual(types, ['text', 'tool_use']);                         // thinking dropped
  assert.ok(out.message.content[1].input.content.endsWith('… [truncated]'));
});

test('slim keeps only text blocks for user events', () => {
  const ev = {
    type: 'user',
    message: { content: [
      { type: 'text', text: 'hi' },
      { type: 'tool_result', content: 'huge result' },
      { type: 'image', source: {} },
    ] },
  };
  assert.deepEqual(slim(ev).message.content.map(b => b.type), ['text']);
});
