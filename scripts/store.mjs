import { existsSync, readFileSync, appendFileSync } from 'node:fs';

// 追加记录避免并发聊天注册互相覆盖；不删除锁、临时文件或旧记录。
export function records(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function append(path, value) {
  appendFileSync(path, '\n' + JSON.stringify(value) + '\n');
}

export function configuration(path) {
  const result = { enabled: false, targets: {}, intervalSeconds: 30 };
  for (const entry of records(path)) {
    if (entry.type === 'disable') result.enabled = false;
    if (entry.type === 'enable') {
      result.enabled = true;
      result.pipe = entry.pipe;
      result.callerThread = entry.threadId;
      result.hostId = entry.hostId;
      result.targets[entry.threadId] = { enabled: true, armedAt: entry.armedAt };
    }
  }
  return result;
}
