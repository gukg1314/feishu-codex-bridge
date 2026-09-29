import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const built = buildSync({
  entryPoints: [resolve('src/core/card.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports);
const { buildLarkCard } = loaded.exports;

test('运行卡片显示最新摘要、当前步骤、完整执行过程和停止按钮', () => {
  const card = buildLarkCard({
    sessionId: 'session-1',
    ownerOpenId: 'ou_owner',
    prompt: '请检查并更新配置',
    status: 'running',
    summary: '配置已读取',
    currentStep: '正在写入配置',
    steps: [
      { title: '检查目录', detail: '目录存在' },
      { title: '读取配置', detail: '加载成功' },
      { title: '核对字段', detail: '发现一处差异' },
      { title: '写入配置', detail: '等待保存' },
      { title: '确认结果', detail: '保存成功' },
    ],
    version: 7,
  });
  assert.equal(card.config.width_mode, 'default');
  const elements = card.body.elements;

  assert.equal(elements[0].content, '> 请检查并更新配置');
  assert.ok(elements.some((item) => item.tag === 'markdown' && item.content.includes('正在执行 · 正在写入配置')));
  assert.ok(elements.some((item) => item.tag === 'markdown' && item.content.includes('配置已读取') && item.content.includes('grey')));

  const history = elements.find((item) => item.tag === 'collapsible_panel');
  assert.ok(history);
  assert.equal(history.expanded, false);
  assert.equal(history.header.title.content, '执行过程');
  assert.equal(history.header.icon.token, 'right_outlined');
  assert.equal(history.header.icon_position, 'follow_text');
  assert.equal(history.header.icon_expanded_angle, 90);
  const historyText = history.elements.map((item) => item.content ?? '').join('\n');
  for (const step of ['检查目录', '读取配置', '核对字段', '写入配置', '确认结果']) {
    assert.ok(historyText.includes(step), `执行过程应包含：${step}`);
  }

  const stopRow = elements.find((item) => item.tag === 'column_set' && item.columns.some((column) =>
    column.elements.some((button) => button.text?.content === '停止')));
  assert.ok(stopRow);
  const stopButton = stopRow.columns.flatMap((column) => column.elements).find((button) => button.text?.content === '停止');
  assert.deepEqual(stopButton.behaviors[0].value, {
    v: 1, action: 'stop_session', sessionId: 'session-1', cardVersion: 7,
  });
});
