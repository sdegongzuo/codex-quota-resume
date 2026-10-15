export function renderPanel(token, canStop) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>额度恢复队列</title>
<style>
*{box-sizing:border-box}body{font:14px system-ui,sans-serif;margin:0;background:#f4f6f8;color:#182435}main{max-width:1440px;margin:28px auto;padding:0 24px}h1{font-size:25px;margin:0}h2{font-size:18px;margin:0}.heading,.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.heading{justify-content:space-between;margin-bottom:18px}.section{background:#fff;border:1px solid #dce2eb;border-radius:12px;margin:18px 0;overflow:hidden}.toolbar{padding:18px 20px;border-bottom:1px solid #e8ecf1}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left;min-width:900px}th{background:#f8fafc;color:#596579;font-size:12px;white-space:nowrap}th,td{padding:13px 16px;border-bottom:1px solid #edf0f4;vertical-align:top}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fafcff}.name{min-width:190px;max-width:340px;overflow-wrap:anywhere}.muted{font-size:12px;color:#69768a;margin-top:5px}.badge{display:inline-block;padding:3px 8px;background:#eef2f7;border-radius:5px;white-space:nowrap}.running{color:#146840;background:#e8f6ee}.stale{color:#8a641d;background:#fff5dc}.actions{display:flex;gap:8px;flex-wrap:wrap;min-width:180px}button,select,input{font:inherit;border:1px solid #b8c3d2;border-radius:7px;padding:7px 10px;background:white;color:inherit}button{cursor:pointer}button:disabled{opacity:.55;cursor:default}button:hover:not(:disabled){background:#f2f6fb}a{color:#1764b7;text-decoration:none}a:hover{text-decoration:underline}input{width:80px}.count{color:#718096;font-size:13px}.empty{text-align:center;padding:28px;color:#718096}.health{color:#596579;font-size:13px;margin:8px 0}.warning{padding:12px 16px;background:#fff8e8;border-left:3px solid #d99100;line-height:1.6}.settings{padding:18px 20px}.settings .toolbar{padding:14px 0;border:0}summary{cursor:pointer;font-weight:600}.meter{width:80px;max-width:100%;height:5px;background:#e8edf4;border-radius:3px;margin-top:7px;overflow:hidden}.meter span{display:block;height:100%;background:#4585cb}.nowrap{white-space:nowrap}#notice{color:#9e3b2d;white-space:pre-wrap}label{display:flex;align-items:center;gap:7px}@media(max-width:700px){main{padding:0 12px;margin:18px auto}.toolbar{padding:14px}h1{font-size:21px}}
</style></head><body><main>
<header class="heading"><h1>五小时额度恢复队列</h1><button id="refresh">刷新</button></header>
<div id="notice" role="status" aria-live="polite"></div>
<section class="section" aria-labelledby="quota-title"><div class="toolbar"><h2 id="quota-title">剩余额度</h2><span id="quota-status" class="count">尚未读取</span></div><div class="table-scroll"><table><thead><tr><th>额度窗口</th><th>剩余比例</th><th>恢复时间（北京时间）</th></tr></thead><tbody id="quota-rows"></tbody></table></div></section>
<section class="section" aria-labelledby="queue-title"><div class="toolbar"><h2 id="queue-title">待续跑任务</h2><span id="queue-count" class="count"></span></div><div class="table-scroll"><table><thead><tr><th>会话</th><th>中断时间</th><th>预计续跑</th><th>状态</th><th>自动续跑</th><th>操作</th></tr></thead><tbody id="items"></tbody></table></div></section>
<section class="section" id="contextUsage" aria-labelledby="context-title"><div class="toolbar"><h2 id="context-title">已监测会话的上下文</h2><label>显示 <select id="session-filter"><option value="all">全部会话</option><option value="running">正在运行</option></select></label><span id="context-count" class="count"></span></div><div class="table-scroll"><table><thead><tr><th>会话</th><th>运行状态</th><th>上下文用量</th><th>占比</th><th>数据更新时间</th><th>压缩状态</th><th>操作</th></tr></thead><tbody id="contextUsageRows"></tbody></table></div></section>
<section class="section settings"><details><summary>设置与后台状态</summary><div class="toolbar"><b>总开关</b><button id="global">正在读取…</button><label>压缩阈值 <input id="threshold" type="number" min="10" max="90" step="5">%</label><button id="save">保存阈值</button></div><div id="settings" class="muted"></div><div id="connection" class="health">尚未确认后台状态</div><div id="cap" class="warning"></div></details></section>
</main><script>(${panelClient.toString()})(${JSON.stringify(token)},${JSON.stringify(canStop)});</script></body></html>`;
}

function panelClient(token, canStop) {
  const $ = id => document.getElementById(id);
  const phases = { waiting: '等待额度', blocked_unavailable: '会话不可用', manual_running: '用户手动续跑中',
    sending: '正在发送', sent: '等待轮次开始', running: '正在续跑', turn_completed: '本轮完成',
    stopped: '已停止', failed: '运行失败', needs_user: '需要用户处理', needs_review: '需要核对',
    uncertain: '发送结果待核对', superseded: '已被新轮次替代', connection_unavailable: '连接不可用' };
  const activityLabels = { running: '正在运行', needs_user: '等待用户处理', turn_completed: '空闲',
    stopped: '已停止', failed: '运行失败', idle: '空闲', not_loaded: '未加载', unknown: '状态未知' };
  const compression = { unsupported: '不支持', not_thresholded: '未达到阈值', waiting_boundary: '等待安全边界',
    compacting: '正在压缩', completed: '已确认', uncertain: '结果待核对', quota_unavailable: '额度许可未确认',
    above_threshold_after_compaction: '压缩后仍高于阈值', error: '读取失败' };
  let current;
  let loading = false;
  const time = value => value === null || value === undefined ? '—' : new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString();
  const node = (tag, value, className) => {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  const cell = (row, value, className) => { const element = node('td', value, className); row.append(element); return element; };
  const link = threadId => { const element = node('a', '打开原会话'); element.href = 'codex://threads/' + encodeURIComponent(threadId); return element; };
  async function api(path, body) {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: {
      'x-quota-resume-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw Error('请求失败（' + response.status + '）');
    return response.json();
  }
  const button = (label, action) => {
    const element = node('button', label);
    element.type = 'button';
    if (label === '停止任务并关闭自动续跑') element.title = '立即停止正在运行的任务，并关闭该会话自动续跑';
    element.onclick = async () => {
      element.disabled = true;
      try { $('notice').textContent = ''; await action(); await refresh(); }
      catch (error) { $('notice').textContent = error.message; }
      finally { element.disabled = false; }
    };
    return element;
  };
  function empty(body, columns, message) {
    const row = node('tr'); const element = cell(row, message, 'empty'); element.colSpan = columns; body.append(row);
  }
  function renderQueue(state) {
    const body = $('items'); body.replaceChildren();
    const terminal = new Set(['turn_completed', 'stopped', 'superseded']);
    const history = state.historyItems || state.items;
    const items = $('show-history').checked ? history : state.items.filter(item => !terminal.has(item.phase));
    const historyCount = history.filter(item => terminal.has(item.phase)).length;
    $('queue-count').textContent = items.length + ' 项' + (historyCount ? ' · 历史 ' + historyCount + ' 项' : '');
    if (!items.length) { empty(body, 6, $('show-history').checked ? '还没有额度中断记录' : '当前没有待续跑任务'); return; }
    for (const item of items) {
      const row = node('tr');
      const name = cell(row, undefined, 'name'); name.append(node('b', item.name || item.threadId));
      if (item.historyCount > 1) name.append(node('div', '历史中断 ' + item.historyCount + ' 次', 'muted'));
      cell(row, time(item.interruptedAt), 'nowrap');
      cell(row, Number.isFinite(item.eligibleAt) ? time(item.eligibleAt) : '恢复时间待核对', 'nowrap');
      const status = cell(row); status.append(node('span', phases[item.phase] || item.phase, 'badge'));
      if (item.reason) status.append(node('div', item.reason, 'muted'));
      const automatic = cell(row);
      automatic.append(button(item.itemEnabled ? '关闭自动续跑' : '开启自动续跑', () =>
        api('/api/item', { id: item.id, enabled: !item.itemEnabled })));
      if (!state.config.enabled || !item.targetEnabled) automatic.append(node('div', !state.config.enabled ? '总开关已关闭' : '会话自动续跑已关闭', 'muted'));
      const actions = node('div', undefined, 'actions'); cell(row).append(actions); actions.append(link(item.threadId));
      if (['sending', 'uncertain'].includes(item.phase)) {
        const resolve = button(item.manualResolutionRequested ? '等待后台核对' : '核对后解除等待', () => api('/api/resolve', { id: item.id }));
        resolve.disabled = item.manualResolutionRequested;
        resolve.title = '核对原会话后解除等待：先确认没有运行中的轮次，再请求核对；不会重发消息'; actions.append(resolve);
      }
      if (canStop && item.canStop && item.runningTurnId) actions.append(button('停止任务并关闭自动续跑', async () => {
        const result = await api('/api/stop', { id: item.id, turnId: item.runningTurnId });
        if (!['completed', 'already_ended'].includes(result.operation?.status)) $('notice').textContent = '停止结果待核对，请打开原会话确认';
      }));
      body.append(row);
    }
  }
  function renderContext() {
    if (!current) return;
    const all = current.contextUsage || [];
    const rows = $('session-filter').value === 'running' ? all.filter(item => item.isRunning === true) : all;
    const body = $('contextUsageRows'); body.replaceChildren();
    $('context-count').textContent = rows.length + ' / ' + all.length + ' 个会话';
    if (!rows.length) { empty(body, 7, $('session-filter').value === 'running' ? '当前没有已确认正在运行的会话' : '暂无已监测会话'); return; }
    for (const item of rows) {
      const row = node('tr'); const name = cell(row, undefined, 'name');
      name.append(node('b', item.name), node('div', item.model || '模型未知', 'muted'));
      const activity = cell(row); activity.append(node('span', activityLabels[item.activityStatus] || '状态未知', 'badge' + (item.isRunning ? ' running' : '')));
      activity.title = '会话状态检查时间：' + time(item.activityObservedAt);
      cell(row, Number.isFinite(item.activeTokens) && Number.isFinite(item.windowTokens)
        ? item.activeTokens.toLocaleString() + ' / ' + item.windowTokens.toLocaleString() : '暂无用量样本', 'nowrap');
      const ratio = cell(row, Number.isFinite(item.ratio) ? Math.round(item.ratio * 100) + '%' : '—');
      if (Number.isFinite(item.ratio)) { const bar = node('div', undefined, 'meter'); const fill = node('span'); fill.style.width = Math.min(100, Math.max(0, item.ratio * 100)) + '%'; bar.append(fill); ratio.append(bar); }
      const updated = cell(row, time(item.timestamp), 'nowrap');
      updated.append(node('div', item.stale ? '数据已过期' : item.status === 'available' ? '观测可用' : item.reason || '暂无用量样本', item.stale ? 'badge stale' : 'muted'));
      const compact = cell(row, compression[item.compactionStatus] || item.compactionStatus || '未知'); compact.title = item.compactionReason || '';
      cell(row).append(link(item.threadId)); body.append(row);
    }
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      current = await api('/api/state'); renderQueue(current); renderContext();
      const quota = current.quota || { status: 'unconfirmed', windows: [] };
      const quotaLabels = { available: '读取成功', unavailable: '读取失败 · 上次数据仅供参考', stale: '数据已过期', unconfirmed: '尚未读取', no_data: '额度数据不可用' };
      $('quota-status').textContent = (quotaLabels[quota.status] || '状态未知') + ' · 更新于 ' + time(quota.observedAt);
      const quotaRows = $('quota-rows'); quotaRows.replaceChildren();
      if (!quota.windows.length) empty(quotaRows, 3, '暂无官方额度数据，等待后台读取');
      for (const window of quota.windows) {
        const row = node('tr');
        cell(row, (window.windowDurationMins === 300 ? '5 小时' : '1 周') + (new Set(quota.windows.map(item => item.bucket)).size > 1 ? ' · ' + window.bucket : ''));
        cell(row, Number.isFinite(window.remainingPercent) ? window.remainingPercent + '%' : '未知');
        cell(row, Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未知');
        quotaRows.append(row);
      }
      $('global').textContent = current.config.enabled ? '已开启（点击关闭）' : '已关闭（点击开启）';
      const input = $('threshold'); if (document.activeElement !== input) input.value = Math.round(current.config.compactionThresholdRatio * 100);
      $('settings').textContent = '恢复缓冲 ' + current.config.resumeBufferSeconds + ' 秒；重查 ' + current.config.recoveryRetrySeconds + ' 秒；页面每 30 秒刷新';
      const connection = current.connection;
      const labels = { available: '后台最近一次检查成功', unavailable: '后台读取失败', degraded: '部分会话读取失败', stale: '后台检查已过期', unconfirmed: '尚未确认后台状态' };
      $('connection').textContent = (labels[connection.status] || '状态未知') + ' · ' + time(connection.observedAt) + (connection.reason ? ' · ' + connection.reason : '');
      $('cap').textContent = '实际压缩：' + current.compaction.status + '。' + (current.compaction.reason || current.capabilities.limitation || '');
    } catch (error) { $('notice').textContent = '页面读取失败：' + error.message; }
    finally { loading = false; }
  }
  const historyLabel = node('label');
  const historyToggle = node('input'); historyToggle.type = 'checkbox'; historyToggle.id = 'show-history'; historyToggle.style.width = 'auto';
  historyLabel.append(historyToggle, document.createTextNode('显示历史'));
  $('queue-count').before(historyLabel);
  historyToggle.onchange = () => { if (current) renderQueue(current); };
  $('session-filter').onchange = renderContext;
  $('refresh').onclick = () => { $('notice').textContent = ''; refresh(); };
  $('global').onclick = async () => { if (!current) return; try { await api('/api/global', { enabled: !current.config.enabled }); refresh(); } catch (error) { $('notice').textContent = error.message; } };
  $('save').onclick = async () => { try { await api('/api/settings', { compactionThresholdRatio: Number($('threshold').value) / 100 }); refresh(); } catch (error) { $('notice').textContent = error.message; } };
  refresh(); setInterval(refresh, 30000);
}
