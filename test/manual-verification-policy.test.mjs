import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const crawlerSource = await readFile(new URL('../src/crawler.mjs', import.meta.url), 'utf8');

function functionBody(name, nextName) {
  const pattern = new RegExp(`async function ${name}\\([\\s\\S]*?(?=\\n(?:async )?function ${nextName}\\()`, 'u');
  const match = crawlerSource.match(pattern);
  assert.ok(match, `未找到函数 ${name}`);
  return match[0];
}

test('登录和安全验证只允许运营人工处理', () => {
  const source = functionBody('handleChallenge', 'hasVisibleText');
  assert.doesNotMatch(source, /\.click\s*\(/u);
  assert.doesNotMatch(source, /\.reload\s*\(/u);
  assert.match(source, /promptEnter/u);
  assert.match(source, /运营人员/u);
});

test('网络或会话异常恢复不得由脚本刷新页面', () => {
  const source = functionBody('resolveTransientProductProblem', 'isBrowserClosedError');
  assert.doesNotMatch(source, /\.reload\s*\(/u);
  assert.doesNotMatch(source, /\.click\s*\(/u);
  assert.match(source, /人工操作/u);
  assert.match(source, /不会自动刷新/u);
});
