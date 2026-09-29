export const windowsCloseDialog = {
  title: '关闭飞书桥接Codex',
  message: '最小化到托盘，还是关闭工具？',
  detail: '最小化后桥接继续运行，可从右下角托盘恢复。',
  buttons: ['最小化到托盘', '关闭工具'],
  defaultId: 0,
  cancelId: 0
};

export async function decideWindowClose(
  platform: NodeJS.Platform,
  choose: (options: typeof windowsCloseDialog) => Promise<number>
): Promise<'hide' | 'quit'> {
  if (platform !== 'win32') return 'hide';
  return (await choose(windowsCloseDialog)) === 1 ? 'quit' : 'hide';
}
