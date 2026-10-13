import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { records, append, configuration, taskId } from './store.mjs';

export function projectQueue(pending, config) {
  const groups = new Map();
  for (const item of Object.values(pending ?? {})) {
    const key = JSON.stringify([item.accountId ?? 'unknown-account', item.hostId ?? 'local', item.threadId]);
    const previous = groups.get(key);
    const historyCount = (previous?.historyCount ?? 0) + 1;
    const safeId = taskId(item.accountId, item.hostId, item.threadId, item.turnId);
    const newest = !previous || item.interruptedAt > previous.newestAt
      || (item.interruptedAt === previous.newestAt && safeId.localeCompare(previous.newestId) > 0);
    const hasUncertainSlot = ['sending', 'uncertain'].includes(item.phase);
    const previousUncertainSlot = ['sending', 'uncertain'].includes(previous?.item.phase);
    const chooseItem = !previous || (hasUncertainSlot !== previousUncertainSlot
      ? hasUncertainSlot : newest);
    groups.set(key, { item: chooseItem ? item : previous.item, historyCount,
      newestAt: newest ? item.interruptedAt : previous.newestAt,
      newestId: newest ? safeId : previous.newestId,
      selectedIsLatest: chooseItem ? newest : (newest ? false : previous.selectedIsLatest) });
  }
  return [...groups.values()].map(({ item, historyCount, selectedIsLatest }) => {
    const id = taskId(item.accountId, item.hostId, item.threadId, item.turnId);
    const itemConfig = config.items?.[id] ?? config.items?.[item.id] ?? config.items?.[item.legacyId] ?? {};
    return {
    id, threadId: item.threadId, name: item.name,
    interruptedAt: item.interruptedAt, eligibleAt: item.eligibleAt,
    phase: item.phase, reason: item.reason, historyCount,
    runningTurnId: item.runningTurnId ?? null,
    isLatest: selectedIsLatest,
    itemEnabled: itemConfig.enabled ?? item.autoResumeEnabled ?? true,
    manualResolutionRequested: Number.isFinite(itemConfig.manualResolutionRequestedAt)
      && itemConfig.manualResolutionRequestedAt > (itemConfig.manualResolutionHandledAt ?? 0),
    targetEnabled: config.targets[item.threadId]?.enabled !== false,
    };
  }).sort((a, b) => a.interruptedAt - b.interruptedAt || a.id.localeCompare(b.id));
}

const html = token => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>额度恢复队列</title>
<style>body{font:15px system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 18px;color:#18202b;background:#f4f6f8}h1{font-size:24px}.bar,.item{background:white;border:1px solid #d9dee5;border-radius:10px;padding:16px;margin:12px 0}.bar{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.item{display:grid;grid-template-columns:1fr auto;gap:8px}.muted{color:#596579;font-size:13px}.warning{border-left:4px solid #d99100;padding:10px;background:#fff8e8}.badge{font-weight:600}button{padding:7px 12px;border:1px solid #aab4c2;border-radius:7px;background:#fff;cursor:pointer}input{width:5em;padding:6px}a{color:#145fbd}</style>
<h1>五小时额度恢复队列</h1><div id="cap" class="warning">正在读取接口能力…</div><div id="connection" class="bar">连接状态：尚未确认</div><div class="bar"><b>总开关</b><button id="global"></button><label>压缩阈值 <input id="threshold" type="number" min="10" max="90" step="5">%</label><button id="save">保存阈值</button><span id="settings" class="muted"></span></div><main id="items"></main>
<script>const token=${JSON.stringify(token)};const phaseText={waiting:'等待额度',blocked_unavailable:'会话不可用',manual_running:'用户手动续跑中',sending:'正在发送',sent:'等待轮次开始',running:'正在续跑',turn_completed:'本轮完成（任务完成状态未知）',stopped:'已停止',failed:'运行失败',needs_user:'需要用户处理',needs_review:'需要核对',uncertain:'发送结果待核对',superseded:'旧中断已被新轮次替代',connection_unavailable:'连接不可用'};const capText={available:'可用',unsupported:'当前桌面不支持',unknown:'未知'};const connectionText={available:'后台最近一次检查已成功',unavailable:'后台连接不可用',unconfirmed:'尚未确认后台连接'};async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{'x-quota-resume-token':token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(await r.text());return r.json()}async function refresh(){try{const s=await api('/api/state');document.querySelector('#cap').innerHTML='<b>实际压缩：</b>'+escapeHtml(s.compaction.status)+'；<b>上下文占用：</b>'+(capText[s.capabilities.activeContextUsage]||s.capabilities.activeContextUsage)+'。'+escapeHtml(s.compaction.reason||s.capabilities.limitation);const c=s.connection||{status:'unconfirmed'};document.querySelector('#connection').textContent=(connectionText[c.status]||connectionText.unconfirmed)+(c.observedAt?'；最后检查 '+new Date(c.observedAt*1000).toLocaleString():'')+(c.reason?'；'+c.reason:'');const g=document.querySelector('#global');g.textContent=s.config.enabled?'已开启（点击关闭）':'已关闭（点击开启）';g.onclick=async()=>{try{await api('/api/global',{enabled:!s.config.enabled});refresh()}catch(e){document.querySelector('#cap').textContent='总开关更新失败：'+e.message}};const input=document.querySelector('#threshold');if(document.activeElement!==input)input.value=Math.round(s.config.compactionThresholdRatio*100);document.querySelector('#settings').textContent='恢复缓冲 '+s.config.resumeBufferSeconds+' 秒；重查 '+s.config.recoveryRetrySeconds+' 秒；列表每 30 秒刷新';const main=document.querySelector('#items');main.replaceChildren();if(!s.items.length){main.textContent='还没有额度中断记录。';return}for(const x of s.items){const d=document.createElement('section');d.className='item';const info=document.createElement('div');const effective=x.itemEnabled&&x.targetEnabled&&s.config.enabled;const status=effective?(phaseText[x.phase]||x.phase):(!s.config.enabled?'总开关已关闭':!x.targetEnabled?'会话自动续跑已关闭':'已关闭');const history=x.historyCount>1?' · 同一会话历史中断 '+x.historyCount+' 次':'';info.innerHTML='<b>'+escapeHtml(x.name||x.threadId)+'</b><div class="muted">中断 '+escapeHtml(new Date(x.interruptedAt*1000).toLocaleString())+' · 预计续跑 '+escapeHtml(new Date(x.eligibleAt*1000).toLocaleString())+history+'</div><div class="badge">状态：'+escapeHtml(status)+'</div><div class="muted">'+escapeHtml(x.reason||'')+'</div><div><a href="codex://threads/'+encodeURIComponent(x.threadId)+'">打开原会话</a></div>';const b=document.createElement('button');b.textContent=x.itemEnabled?(x.isLatest?'关闭最新中断':'关闭待核对项'):(x.isLatest?'开启最新中断':'开启待核对项');b.title='此开关只作用于当前卡片代表的这次中断；完整历史仍保留。';b.onclick=async()=>{try{await api('/api/item',{id:x.id,enabled:!x.itemEnabled});refresh()}catch(e){document.querySelector('#cap').textContent='任务开关更新失败：'+e.message}};d.append(info,b);if(['sending','uncertain'].includes(x.phase)){const r=document.createElement('button');r.textContent=x.manualResolutionRequested?'已请求核对，等待后台复查':'核对原会话后解除等待';r.disabled=x.manualResolutionRequested;r.title='请先打开原会话确认没有运行中的轮次；后台会再次检查，不会自动重发。';r.onclick=async()=>{try{await api('/api/resolve',{id:x.id});refresh()}catch(e){document.querySelector('#cap').textContent='核对请求失败：'+e.message}};d.append(r)}main.append(d)}}catch(e){document.querySelector('#cap').textContent='面板请求失败：'+e.message}}function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}document.querySelector('#save').onclick=async()=>{try{await api('/api/settings',{compactionThresholdRatio:Number(document.querySelector('#threshold').value)/100});refresh()}catch(e){document.querySelector('#cap').textContent='保存失败：'+e.message}};refresh();setInterval(refresh,30000);</script></html>`;

function withContextPanel(page, token) {
  const panel = '<section id="contextUsage" class="bar"><b>已监测会话的上下文</b><div id="contextUsageRows"></div><p class="muted">立即停止正在运行的任务，请打开对应原会话并使用桌面“停止”按钮。此列表开关只控制自动续跑。</p></section>';
  const script = `<script>const contextToken=${JSON.stringify(token)};async function refreshContextUsage(){const host=document.querySelector('#contextUsageRows');try{const response=await fetch('/api/state',{headers:{'x-quota-resume-token':contextToken}});if(!response.ok)throw Error('读取失败 '+response.status);const data=await response.json();host.replaceChildren();for(const item of data.contextUsage||[]){const row=document.createElement('div');row.className='muted';const label=document.createElement('b');label.textContent=item.name+'：';row.append(label);if(item.status==='available'||item.status==='stale'){row.append(document.createTextNode(item.activeTokens+' / '+item.windowTokens+' tokens ('+Math.round(item.ratio*100)+'%) · '+(item.stale?'数据已过期':'观测可用')+' · '+new Date(item.timestamp).toLocaleString()+' · 回执延迟 '+Math.round(item.completionDelaySeconds)+' 秒 · '+(item.model||'模型未知')))}else row.append(document.createTextNode(({awaiting_post_compaction_usage:'压缩后等待新用量',not_found:'找不到日志',unverified:'会话映射未通过校验',unavailable:'暂无用量样本'}[item.status]||item.status)+' · '+(item.reason||'')));const compaction=document.createElement('span');compaction.textContent=' · 实际压缩：'+({unsupported:'不支持',not_thresholded:'未达到阈值',waiting_boundary:'等待安全边界',compacting:'正在压缩',completed:'已确认',uncertain:'结果待核对',quota_unavailable:'额度许可未确认'}[item.compactionStatus]||item.compactionStatus);row.append(compaction);const link=document.createElement('a');link.href='codex://threads/'+encodeURIComponent(item.threadId);link.textContent='打开原会话';link.style.marginLeft='8px';row.append(link);host.append(row)}}catch(error){host.textContent='上下文观测读取失败：'+error.message}}refreshContextUsage();setInterval(refreshContextUsage,30000);</script>`;
  return page.replace('<main id="items"></main>', panel + '<main id="items"></main>')
    .replace('关闭最新中断', '关闭自动续跑').replace('开启最新中断', '开启自动续跑')
    .replace('</script></html>', '</script>' + script + '</html>');
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function withStopPanel(page, token, enabled) {
  if (!enabled) return page;
  const section = '<section id="running-controls"><h2>正在续跑的任务</h2><div id="running-items"></div></section>';
  const script = `<script>(function(){const token=${JSON.stringify(token)};const host=document.getElementById('running-items');async function refresh(){try{const response=await fetch('/api/state',{headers:{'x-quota-resume-token':token}});const state=await response.json();host.replaceChildren();const items=state.items.filter(item=>item.phase==='running'&&item.runningTurnId);if(!items.length){host.textContent='当前没有正在自动续跑的任务';return}for(const item of items){const row=document.createElement('div');const label=document.createElement('span');label.textContent=item.name||'原会话';row.append(label);const button=document.createElement('button');button.textContent='停止任务并关闭自动续跑';button.style.marginLeft='8px';const result=document.createElement('span');button.onclick=async()=>{button.disabled=true;result.textContent=' 正在请求停止';try{const response=await fetch('/api/stop',{method:'POST',headers:{'content-type':'application/json','x-quota-resume-token':token},body:JSON.stringify({id:item.id,turnId:item.runningTurnId})});const value=await response.json();if(!response.ok)throw Error(value.error||'停止请求失败');result.textContent=value.operation?.status==='completed'?' 已确认停止':value.operation?.status==='already_ended'?' 该轮次已结束':' 停止结果待核对，请打开原会话确认';}catch(error){result.textContent=' '+error.message;} };row.append(button,result);host.append(row)}}catch{host.textContent='读取运行任务失败，请刷新页面'}}refresh();setInterval(refresh,30000)})();</script>`;
  return page.replace('立即停止正在运行的任务，请打开对应原会话并使用桌面“停止”按钮。此列表开关只控制自动续跑。',
    '列表开关控制后续自动续跑。正在续跑的任务可使用下方停止按钮；结果待核对时请打开原会话确认。')
    .replace('<main id="items"></main>', '<main id="items"></main>' + section)
    .replace('</html>', script + '</html>');
}

export function startPanel({ host = '127.0.0.1', port = 0, configPath, statePath, capabilities,
  onGlobalEnabled = async () => {}, onStop = null }) {
  const token = randomBytes(32).toString('base64url');
  const server = createServer(async (request, response) => {
    try {
    const address = request.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return json(response, 403, { error: '只允许本机访问' });
    const actualPort = server.address()?.port;
    const exactOrigin = `http://${host}:${actualPort}`;
    if (request.headers.host !== `${host}:${actualPort}`) return json(response, 403, { error: 'Host 不匹配' });
    const origin = request.headers.origin;
    if (origin && origin !== exactOrigin) return json(response, 403, { error: '来源不匹配' });
    if (request.url?.split('?')[0] === '/') {
      const url = new URL(request.url, `http://${host}`);
      if (url.searchParams.get('token') !== token) return json(response, 403, { error: '缺少本机访问令牌' });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(withStopPanel(withContextPanel(html(token), token), token, typeof onStop === 'function')); return;
    }
    const supplied = Buffer.from(request.headers['x-quota-resume-token'] ?? '');
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(response, 403, { error: '令牌无效' });
    const config = configuration(configPath);
    if (request.method === 'GET' && request.url === '/api/state') {
      const state = records(statePath).at(-1) ?? { pending: {} };
      const items = projectQueue(state.pending, config);
      const connection = state.connection ? {
        status: state.connection.status,
        observedAt: state.connection.observedAt,
        reason: state.connection.reason,
      } : { status: 'unconfirmed', observedAt: null, reason: null };
      const safeConfig = { enabled: config.enabled, compactionThresholdRatio: config.compactionThresholdRatio,
        resumeBufferSeconds: config.resumeBufferSeconds, recoveryRetrySeconds: config.recoveryRetrySeconds };
      const compaction = state.compaction ?? { status: capabilities.compaction, reason: capabilities.limitation };
      const contextUsage = Object.entries(state.contextUsageByTarget ?? {}).map(([threadId, sample]) => {
        const delay = sample.timestamp ? Math.max(0, (Date.now() - Date.parse(sample.timestamp)) / 1000) : null;
        const stale = sample.stale === true || delay !== null && delay > 120;
        return {
          threadId, name: config.targets?.[threadId]?.name ?? threadId,
          status: sample.status === 'available' && stale ? 'stale' : sample.status,
          activeTokens: sample.activeTokens ?? null, windowTokens: sample.windowTokens ?? null,
          ratio: sample.ratio ?? null, model: sample.model ?? null, turnId: sample.turnId ?? null,
          timestamp: sample.timestamp ?? null, stale,
          completionDelaySeconds: delay ?? sample.completionDelaySeconds ?? null,
          reason: sample.reason ?? null,
          compactionStatus: state.compactionByTarget?.[threadId]?.status ?? 'unsupported',
          compactionReason: state.compactionByTarget?.[threadId]?.reason ?? '未发现经过验证的桌面实际压缩接口',
        };
      });
      const compactionLabels = { unsupported: '不支持', not_thresholded: '未达到阈值',
        waiting_boundary: '等待安全边界', compacting: '压缩进行中', completed: '压缩已确认',
        uncertain: '压缩结果待核对', quota_unavailable: '额度许可未确认',
        above_threshold_after_compaction: '压缩后仍高于阈值' };
      return json(response, 200, { config: safeConfig, items, connection, capabilities, contextUsage,
        compaction: { ...compaction, status: compactionLabels[compaction.status] ?? compaction.status } });
    }
    if (request.method !== 'POST') return json(response, 404, { error: 'not found' });
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 8192) return json(response, 413, { error: 'request too large' }); }
    let value;
    try { value = JSON.parse(body); } catch { return json(response, 400, { error: 'invalid JSON' }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return json(response, 400, { error: '请求内容必须是JSON对象' });
    }
    if (request.url === '/api/global' && typeof value.enabled === 'boolean') {
      append(configPath, { type: 'global', enabled: value.enabled });
      if (value.enabled) await onGlobalEnabled();
    }
    else if (request.url === '/api/item' && typeof value.id === 'string' && typeof value.enabled === 'boolean') {
      const state = records(statePath).at(-1) ?? { pending: {} };
      const item = state.pending?.[value.id] ?? Object.values(state.pending ?? {}).find(candidate =>
        taskId(candidate.accountId, candidate.hostId, candidate.threadId, candidate.turnId) === value.id);
      if (!item) return json(response, 404, { error: 'queue item not found' });
      append(configPath, { type: 'item', id: value.id, value: { enabled: value.enabled } });
    } else if (request.url === '/api/stop' && typeof value.id === 'string' && typeof value.turnId === 'string') {
      if (typeof onStop !== 'function') return json(response, 501, { error: '当前安装尚未接通原生停止接口' });
      const state = records(statePath).at(-1) ?? { pending: {} };
      const item = Object.values(state.pending ?? {}).find(candidate =>
        taskId(candidate.accountId, candidate.hostId, candidate.threadId, candidate.turnId) === value.id);
      if (!item || item.phase !== 'running' || !item.runningTurnId || item.runningTurnId !== value.turnId) {
        return json(response, 409, { error: '运行轮次已变化，请刷新任务列表后操作' });
      }
      // Retain the user's stop choice before requesting the backend operation.
      append(configPath, { type: 'item', id: value.id, value: { enabled: false } });
      append(configPath, { type: 'target', threadId: item.threadId, value: { enabled: false } });
      const result = await onStop({ threadId: item.threadId, turnId: value.turnId,
        requestId: `stop:${value.id}:${value.turnId}` });
      return json(response, 200, { saved: true, operation: result });
    } else if (request.url === '/api/resolve' && typeof value.id === 'string') {
      const state = records(statePath).at(-1) ?? { pending: {} };
      const item = state.pending?.[value.id] ?? Object.values(state.pending ?? {}).find(candidate =>
        taskId(candidate.accountId, candidate.hostId, candidate.threadId, candidate.turnId) === value.id);
      if (!item || !['sending', 'uncertain'].includes(item.phase)) return json(response, 409, { error: '只有发送结果待核对的任务可请求解除等待' });
      const itemConfig = config.items?.[value.id] ?? {};
      if (!(Number.isFinite(itemConfig.manualResolutionRequestedAt)
        && itemConfig.manualResolutionRequestedAt > (itemConfig.manualResolutionHandledAt ?? 0))) {
        append(configPath, { type: 'item', id: value.id, value: { manualResolutionRequestedAt: Math.floor(Date.now() / 1000) } });
      }
    }
    else if (request.url === '/api/settings' && Number.isFinite(value.compactionThresholdRatio)
      && value.compactionThresholdRatio >= 0.1 && value.compactionThresholdRatio <= 0.9) {
      append(configPath, { type: 'settings', value: { compactionThresholdRatio: value.compactionThresholdRatio } });
    } else return json(response, 400, { error: 'unsupported setting' });
    return json(response, 200, { saved: true });
    } catch {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) return response.destroy();
      return json(response, request.aborted ? 400 : 500,
        { error: request.aborted ? '请求读取中断' : '面板请求处理失败' });
    }
  });
  server.listen(port, host);
  return { server, token, getUrl: () => `http://${host}:${server.address().port}/?token=${encodeURIComponent(token)}` };
}
