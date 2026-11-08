/* ===== Claw 模式 · 多个 Agent 同时工作 =====
 *
 * 做了什么：在「设置 → Claw 模式」里打开开关后，给 AI 增加一个 claw_dispatch 工具，
 *          AI 可以把一个大任务拆成多份，派给多个子 Agent 并行执行（真正同时工作），
 *          最后由主 Agent 汇总各自结论。
 *
 * 四个安全取舍（都是有意的，改动前想清楚代价）：
 *   1. 默认关闭：不开开关时工具直接返回提示，不会偷偷花钱。
 *   2. 子 Agent 只读：只给 list_files / read_file / search_files，不给写权限
 *      —— 否则多个 Agent 并行写同一个文件会互相覆盖，且会引发确认弹窗风暴。
 *   3. 不递归：子 Agent 拿不到 claw_dispatch，结构上不可能指数级扩散。
 *   4. 同一时刻只跑一批：重复派发被拒绝，避免并发叠加把额度烧穿。
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '\u0026amp;', '<': '\u0026lt;', '>': '\u0026gt;', '"': '\u0026quot;', "'": '\u0026#39;' }[m]));

const CLAW_MAX_RESULT = 2400;   // 单个子 Agent 结论回传给主 Agent 的字符上限

let clawRun = null;             // { started, done, ms, states: [{ name, status, ms, note }] }
let clawInjectTimer = null;

/* ---------- 配置读取（每次都读最新，保证设置改完立刻生效） ---------- */
function clawSettings() {
  const c = AgentAPI.cfg;
  return {
    enabled: !!c.clawEnabled,
    concurrency: Math.max(1, Math.min(8, Number(c.clawConcurrency) || 3)),
    maxAgents: Math.max(1, Math.min(12, Number(c.clawMaxAgents) || 6)),
    maxLoops: Math.max(1, Math.min(8, Number(c.clawMaxLoops) || 6)),
    timeoutSec: Math.max(10, Math.min(300, Number(c.clawTimeoutSec) || 90)),
    readTools: c.clawReadTools !== false
  };
}

/* ---------- 端点：优先复用主程序的 buildEndpoint（会处理 /v1 补齐与代理） ---------- */
function clawEndpoint() {
  if (typeof buildEndpoint === 'function') return buildEndpoint();
  let b = String(AgentAPI.cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('请先在设置里填写 API Base URL');
  if (!/\/chat\/completions$/.test(b)) {
    if (!/\/v\d+[a-z0-9]*$/i.test(b)) b += '/v1';
    b += '/chat/completions';
  }
  return b;
}

/* ---------- 子 Agent 可用的只读工具（自己定义，不走全局工具表，防止越权） ---------- */
const CLAW_READ_TOOLS = [
  { type: 'function', function: { name: 'list_files', description: '列出某个目录下的文件与子目录', parameters: { type: 'object', properties: { path: { type: 'string', description: '绝对路径，如 /notes' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'read_file', description: '读取文件内容。可用 query 关键词定位，或用 start_line/end_line 读行范围', parameters: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string', description: '可选，关键词' }, start_line: { type: 'integer', description: '可选，起始行 1-based' }, end_line: { type: 'integer', description: '可选，结束行 1-based 含' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_files', description: '按文件名或文件内容搜索', parameters: { type: 'object', properties: { query: { type: 'string' }, in_path: { type: 'string', description: '可选，限定目录' } }, required: ['query'] } } }
];

/* ---------- 单次模型调用（非流式，带超时信号） ---------- */
async function clawCall(messages, tools, signal) {
  const c = AgentAPI.cfg;
  const headers = { 'Content-Type': 'application/json' };
  if (c.apiKey) headers['Authorization'] = 'Bearer ' + c.apiKey;
  const body = {
    model: c.model || 'gpt-4o-mini',
    messages: messages,
    temperature: typeof c.temperature === 'number' ? c.temperature : 0.3,
    stream: false
  };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  const r = await fetch(clawEndpoint(), { method: 'POST', headers: headers, body: JSON.stringify(body), signal: signal });
  if (!r.ok) {
    let d = '';
    try { d = await r.text(); } catch (e) {}
    throw new Error('API ' + r.status + ' ' + String(d).slice(0, 300));
  }
  const j = await r.json();
  if (j && j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  const m = j && j.choices && j.choices[0] && j.choices[0].message;
  if (!m) throw new Error('模型没有返回内容');
  return m;
}

/* ---------- 一个子 Agent 的完整生命周期 ---------- */
async function runSubAgent(item, index, shared, signal, onProgress) {
  const conf = clawSettings();
  const name = item.name;
  const t0 = Date.now();
  onProgress(name, 'working');

  const sys = [
    '你是 Claw 模式下的一名并行子 Agent，代号「' + name + '」。',
    '你和其他几名 Agent 同时工作，各自负责不同部分；不要假设别人做了你的活，也不要替别人做。',
    '',
    '输出要求：',
    '1. 直接给结论，不要复述任务，不要客套话。',
    '2. 结论先行；需要依据时给出具体证据（文件路径、行号、数据、原文片段）。',
    '3. 不确定就明确写「不确定」并说明缺什么，绝对不要编造。',
    '4. 你没有写入权限，不要尝试修改文件，也不要提议派发新任务。',
    '5. 本环境工具的两个已知坑，别把工具报错误当成事实：',
    '   · search_files 对超大文件（如 /index.html）会返回假阴性——「未找到」不代表不存在，优先用 read_file(path, query=关键词) 定位；',
    '   · list_files 传 path 有时误报「目录不存在或不是目录」，此时可先 list_files 看根目录再逐层判断，或直接用 read_file 试读。',
    '6. 拿到「查不到」的结论前先换一种工具交叉验证一次，仍查不到才在结论里写「不确定」。',
    '',
    '【共享背景】',
    String(shared || '（无，全部信息都在你的任务描述里）')
  ].join('\n');

  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: item.task }
  ];

  let useTools = conf.readTools;
  for (let loop = 0; loop < conf.maxLoops; loop++) {
    let m;
    try {
      m = await clawCall(messages, useTools ? CLAW_READ_TOOLS : null, signal);
    } catch (e) {
      // 模型不支持 tools 参数时（部分兼容接口会 400），降级为纯对话重试一次
      const msg = String(e && e.message || e);
      if (useTools && /tool|function/i.test(msg) && loop === 0) {
        useTools = false;
        m = await clawCall(messages, null, signal);
      } else {
        throw e;
      }
    }

    const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!tcs.length) {
      const text = String(m.content || '').trim();
      return { name: name, ok: true, text: text || '（无输出）', ms: Date.now() - t0 };
    }

    messages.push({ role: 'assistant', content: m.content || '', tool_calls: tcs });
    for (const tc of tcs) {
      let out = '';
      try {
        const a = JSON.parse((tc.function && tc.function.arguments) || '{}');
        out = await AgentAPI.executeTool(tc.function.name, a);
      } catch (e) {
        out = '工具执行失败：' + String(e && e.message || e);
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 6000) });
    }
  }
  // 工具轮数用完时不要硬失败：关掉工具再问一次，逼它基于已读内容收口。
  // 子 Agent 往往把轮数全花在"读"上，直接丢弃等于白花钱。
  try {
    messages.push({ role: 'user', content: '工具轮数已用完，不能再调用任何工具。请立刻基于你目前已经读到的内容给出结论：写清查到了什么、关键证据是什么、哪些没来得及查。不要道歉，不要解释过程。' });
    const f = await clawCall(messages, null, signal);
    const ft = String(f && f.content || '').trim();
    if (ft) {
      return { name: name, ok: true, text: ft + '\n\n（注：工具轮数上限 ' + conf.maxLoops + ' 已用完，此结论基于已读到的部分内容）', ms: Date.now() - t0 };
    }
  } catch (e) { /* 收口也失败，落到下面的错误 */ }
  return { name: name, ok: false, text: '', error: '超过最大工具轮数（' + conf.maxLoops + '）且收口失败', ms: Date.now() - t0 };
}

/* ---------- 并发池：限制同时运行的数量 ---------- */
async function clawPool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) {
    runners.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = await worker(items[i], i);
        } catch (e) {
          out[i] = { name: items[i].name, ok: false, error: String(e && e.name === 'AbortError' ? '超时被中止' : (e && e.message || e)), ms: 0 };
        }
      }
    })());
  }
  await Promise.all(runners);
  return out;
}

/* ---------- 浮层：让用户看得见「确实有多个 Agent 在同时干活」 ---------- */
function clawRender(meta) {
  let el = document.getElementById('clawPanel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'clawPanel';
    el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9998;width:300px;background:var(--bg-panel,#1d2128);border:1px solid var(--border,#39404a);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.42);font-size:12px;overflow:hidden';
    el.innerHTML = '<div id="clawHead" style="display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border,#39404a)">'
      + '<span style="font-weight:600;color:var(--text-primary,#e6e8ea)">Claw 模式</span>'
      + '<span id="clawMeta" style="color:var(--text-muted,#8b949e);flex:1;text-align:right"></span>'
      + '<span id="clawClose" style="cursor:pointer;color:var(--text-muted,#8b949e);padding:0 2px">✕</span></div>'
      + '<div id="clawRows" style="padding:6px 10px 10px;max-height:240px;overflow:auto"></div>';
    document.body.appendChild(el);
    el.querySelector('#clawClose').addEventListener('click', () => el.remove());
  }
  const metaEl = el.querySelector('#clawMeta');
  if (metaEl) metaEl.textContent = meta || '';
  const rows = el.querySelector('#clawRows');
  if (!rows) return;
  const states = clawRun ? clawRun.states : [];
  if (!states.length) { rows.innerHTML = '<div style="color:var(--text-muted,#8b949e)">暂无任务</div>'; return; }
  const colorOf = (s) => s === 'working' ? '#4a9eff' : s === 'done' ? '#3fb950' : s === 'error' ? '#f85149' : '#6e7681';
  const textOf = (s) => s === 'working' ? '运行中' : s === 'done' ? '完成' : s === 'error' ? '失败' : '排队';
  rows.innerHTML = states.map(s =>
    '<div style="display:flex;align-items:center;gap:6px;padding:3px 0">'
    + '<span style="color:' + colorOf(s.status) + '">●</span>'
    + '<span style="flex:1;color:var(--text-primary,#e6e8ea);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.name) + '</span>'
    + '<span style="color:var(--text-muted,#8b949e)">' + textOf(s.status) + (s.ms ? ' ' + (s.ms / 1000).toFixed(1) + 's' : '') + '</span>'
    + '</div>'
  ).join('');
}

/* ---------- 工具一：派发 ---------- */
async function clawDispatch(args) {
  const conf = clawSettings();
  if (!conf.enabled) {
    return 'Claw 模式未开启。请让用户到「设置 → Claw 模式」打开开关，之后才能派发子 Agent。';
  }
  if (clawRun && !clawRun.done) {
    return '错误：上一批子 Agent 还在运行（' + clawRun.states.filter(s => s.status === 'working').length + ' 个进行中）。等它们结束再派发，或先看 claw_status。';
  }

  // tasks 可能以三种形态进来：真数组、JSON 字符串、单个任务对象（工具层常把数组序列化成字符串）
  let raw = args.tasks;
  if (typeof raw === 'string') {
    const s = raw.trim();
    try {
      raw = JSON.parse(s);
    } catch (e) {
      return '错误：tasks 不是合法 JSON。应传数组，例如 [{"agent":"调研员","task":"..."}]。收到的原文（前 200 字）：' + s.slice(0, 200);
    }
  }
  if (raw && !Array.isArray(raw) && typeof raw === 'object' && Array.isArray(raw.tasks)) raw = raw.tasks;
  if (raw && !Array.isArray(raw) && typeof raw === 'object') raw = [raw];
  if (!Array.isArray(raw)) raw = [];

  const items = raw.map((t, i) => {
    // 也允许直接传字符串，此时自动编号
    if (typeof t === 'string') return { name: 'agent-' + (i + 1), task: t.trim() };
    return {
      name: String((t && (t.agent || t.name || t.role)) || ('agent-' + (i + 1))).slice(0, 24),
      task: String((t && (t.task || t.prompt || t.instruction || t.content)) || '').trim()
    };
  }).filter(t => t.task);

  if (!items.length) return '错误：tasks 为空。诊断信息 → 收到类型=' + (typeof args.tasks) + '｜是否数组=' + Array.isArray(args.tasks) + '｜参数键=' + Object.keys(args || {}).join(',') + '｜原文=' + JSON.stringify(args).slice(0, 400) + '。每项形如 {"agent":"调研员","task":"具体要做什么"}，task 必须自包含。';
  if (items.length > conf.maxAgents) return '错误：派发了 ' + items.length + ' 个子 Agent，超过上限 ' + conf.maxAgents + '。请合并任务，或让用户到设置里调高上限。';

  let limit = Number(args.concurrency) > 0 ? Math.floor(Number(args.concurrency)) : conf.concurrency;
  limit = Math.max(1, Math.min(limit, conf.concurrency, items.length));

  const started = Date.now();
  clawRun = { started: started, done: false, ms: 0, states: items.map(it => ({ name: it.name, status: 'pending', ms: 0 })) };
  clawRender(limit + ' 路并发 · 0/' + items.length);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conf.timeoutSec * 1000);
  let results;
  try {
    results = await clawPool(items, limit, async (item, i) => {
      const r = await runSubAgent(item, i, args.context, ctrl.signal, (nm, st) => {
        const s = clawRun && clawRun.states.find(x => x.name === nm);
        if (s) { s.status = st; clawRender(limit + ' 路并发 · ' + clawRun.states.filter(x => x.status === 'working').length + ' 个进行中'); }
      });
      const s = clawRun && clawRun.states.find(x => x.name === r.name);
      if (s) { s.status = r.ok ? 'done' : 'error'; s.ms = r.ms; }
      clawRender(limit + ' 路并发 · 已完成 ' + clawRun.states.filter(x => x.status === 'done' || x.status === 'error').length + '/' + items.length);
      return r;
    });
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  clawRun.done = true;
  clawRun.ms = ms;
  clawRender('完成 ' + results.filter(r => r.ok).length + '/' + results.length + ' · ' + (ms / 1000).toFixed(1) + 's');

  const okN = results.filter(r => r.ok).length;
  const body = results.map((r, i) => {
    const st = r.ok ? '✓ ' + (r.ms / 1000).toFixed(1) + 's' : '✗ ' + (r.error || '失败');
    let txt = r.ok ? String(r.text || '') : '';
    if (txt.length > CLAW_MAX_RESULT) txt = txt.slice(0, CLAW_MAX_RESULT) + '\n……（已截断，需要全文请读 /conversations/ 存档或自己复核）';
    return '─── [' + (i + 1) + '] ' + r.name + ' ' + st + ' ───\n' + (txt || '（无内容）');
  }).join('\n\n');

  return [
    'Claw 模式：' + results.length + ' 个子 Agent 并行完成（成功 ' + okN + '/' + results.length + '，总耗时 ' + (ms / 1000).toFixed(1) + 's，' + limit + ' 路并发）',
    '',
    body,
    '',
    '提示：以上是各子 Agent 的独立结论，可能有重复或互相矛盾。请你自己核对、合并后再回答用户，不要把原始结论直接堆给用户。'
  ].join('\n');
}

/* ---------- 工具二：查看状态 ---------- */
function clawStatus() {
  const conf = clawSettings();
  if (!clawRun) return 'Claw 模式当前状态：' + (conf.enabled ? '已开启' : '未开启') + '，没有运行记录。';
  const lines = clawRun.states.map((s, i) => '[' + (i + 1) + '] ' + s.name + ' — ' + (s.status === 'working' ? '运行中' : s.status === 'done' ? '完成 ' + (s.ms / 1000).toFixed(1) + 's' : s.status === 'error' ? '失败' : '排队'));
  return 'Claw 模式：' + (clawRun.done ? '已结束（总耗时 ' + (clawRun.ms / 1000).toFixed(1) + 's）' : '运行中…') + '\n' + lines.join('\n');
}

/* ---------- 设置页注入：新增「Claw 模式」分组 ---------- */
function clawEnsureInjected() {
  try {
    const nav = document.querySelector('.settings-nav');
    const adv = document.querySelector('.settings-pane[data-pane="adv"]');
    if (!nav || !adv) return false;

    if (!nav.querySelector('[data-tab="claw"]')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-nav-btn';
      btn.dataset.tab = 'claw';
      btn.textContent = 'Claw 模式';
      btn.addEventListener('click', () => {
        if (typeof switchSettingsTab === 'function') switchSettingsTab('claw');
      });
      nav.appendChild(btn);
    }

    if (!document.querySelector('.settings-pane[data-pane="claw"]')) {
      const p = document.createElement('div');
      p.className = 'settings-pane';
      p.dataset.pane = 'claw';
      p.innerHTML =
        '<div class="field">'
        + '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">'
        + '<input type="checkbox" id="clawEnabled" style="width:auto;accent-color:var(--accent)"> 开启 Claw 模式（多个 Agent 同时工作）</label>'
        + '<div style="font-size:11.5px;color:var(--text-muted);line-height:1.7;margin-top:6px">'
        + '开启后 AI 会多出一个 <code>claw_dispatch</code> 工具，可以把自己的任务拆成多份，派给多个子 Agent <b>并行</b>执行，最后汇总结论。'
        + '适合：多文件并行调研、多方案并行设计、分章节并行写作、多角度并行审查。</div></div>'
        + '<div class="row2">'
        + '<div class="field"><label>同时运行数</label><input type="number" id="clawConcurrency" min="1" max="8"></div>'
        + '<div class="field"><label>单批最多子 Agent</label><input type="number" id="clawMaxAgents" min="1" max="12"></div></div>'
        + '<div class="row2">'
        + '<div class="field"><label>单个子 Agent 最大工具轮数</label><input type="number" id="clawMaxLoops" min="1" max="8"></div>'
        + '<div class="field"><label>整批超时（秒）</label><input type="number" id="clawTimeoutSec" min="10" max="300"></div></div>'
        + '<div class="field"><label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">'
        + '<input type="checkbox" id="clawReadTools" style="width:auto;accent-color:var(--accent)"> 允许子 Agent 使用只读工具（list_files / read_file / search_files）</label>'
        + '<div style="font-size:11.5px;color:var(--text-muted);line-height:1.7;margin-top:6px">'
        + '关掉后子 Agent 只能凭你给的任务描述回答，不读文件。子 Agent <b>永远没有写权限</b>，避免多个 Agent 并行改写同一文件。</div></div>'
        + '<div class="field"><button class="ghost-btn" id="btnClawSave" type="button">保存 Claw 设置</button></div>'
        + '<div class="field" style="font-size:11.5px;color:var(--text-muted);line-height:1.7">'
        + '费用提示：N 个子 Agent 并行 = N 份并发请求，token 消耗随数量线性增长，建议 2~4 个起步。'
        + '子 Agent 用的是当前激活预设的模型与 Key。</div>';
      adv.parentElement.appendChild(p);

      const g = (id) => document.getElementById(id);
      p.querySelector('#btnClawSave').addEventListener('click', async () => {
        const c = AgentAPI.cfg;
        c.clawEnabled = !!g('clawEnabled').checked;
        c.clawConcurrency = Math.max(1, Math.min(8, Number(g('clawConcurrency').value) || 3));
        c.clawMaxAgents = Math.max(1, Math.min(12, Number(g('clawMaxAgents').value) || 6));
        c.clawMaxLoops = Math.max(1, Math.min(8, Number(g('clawMaxLoops').value) || 3));
        c.clawTimeoutSec = Math.max(10, Math.min(300, Number(g('clawTimeoutSec').value) || 90));
        c.clawReadTools = !!g('clawReadTools').checked;
        try {
          if (typeof saveCfg === 'function') await saveCfg();
          AgentAPI.toast('Claw 设置已保存');
        } catch (e) {
          AgentAPI.toast('保存失败：' + (e && e.message || e), 'err');
        }
      });
    }

    // 回填当前配置（设置页可能被反复打开）
    const c = AgentAPI.cfg;
    const set = (id, val) => { const el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = !!val; else el.value = val; } };
    set('clawEnabled', c.clawEnabled);
    set('clawConcurrency', Number(c.clawConcurrency) || 3);
    set('clawMaxAgents', Number(c.clawMaxAgents) || 6);
    set('clawMaxLoops', Number(c.clawMaxLoops) || 3);
    set('clawTimeoutSec', Number(c.clawTimeoutSec) || 90);
    set('clawReadTools', c.clawReadTools !== false);
    return true;
  } catch (e) {
    console.warn('[claw] 设置页注入失败', e);
    return false;
  }
}

// DOM 可能还没就绪，重试几次（不无限重试，避免白耗）
let clawTries = 0;
function clawScheduleInject() {
  if (clawEnsureInjected()) return;
  if (clawTries++ >= 20) return;
  clawInjectTimer = setTimeout(clawScheduleInject, 500);
}
clawTries = 0;
clawScheduleInject();

/* ---------- 注册工具 ---------- */
AgentAPI.defineTool('claw_dispatch', {
  description: 'Claw 模式专用：把你的任务拆成多份，派给多个子 Agent 并行执行（同时工作），返回各自结论。'
    + '每个子任务的 task 必须自包含（子 Agent 看不到当前对话历史，只能看到你写的 task 和 context）。'
    + '子 Agent 只有只读能力，不会修改文件。需要用户先在「设置 → Claw 模式」打开开关。'
    + '适合：多文件并行调研、多方案并行设计、分章节并行写作、多角度并行审查。'
    + '结果回来后必须自己核对合并，不要把原始结论直接堆给用户。',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: '子任务列表。建议 2~4 个，最多读设置里的上限',
        items: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: '代号，便于区分，如「调研员A」「审核员」' },
            task: { type: 'string', description: '该子 Agent 要完成的具体任务，必须自包含' }
          },
          required: ['task']
        }
      },
      context: { type: 'string', description: '可选，共享背景：目标、已知结论、约束、关键文件路径。会注入每个子 Agent' },
      concurrency: { type: 'integer', description: '可选，同时运行的数量，不超过设置里的「同时运行数」' }
    },
    required: ['tasks']
  }
}, async (args) => clawDispatch(args || {}));

AgentAPI.defineTool('claw_status', {
  description: 'Claw 模式：查看当前这一批子 Agent 的运行状态（排队 / 运行中 / 完成 / 失败）与总耗时。无参数。',
  parameters: { type: 'object', properties: {} }
}, () => clawStatus());

/* ---------- 卸载清理 ---------- */
onUnload(() => {
  if (clawInjectTimer) { clearTimeout(clawInjectTimer); clawInjectTimer = null; }
  const panel = document.getElementById('clawPanel');
  if (panel) panel.remove();
  const navBtn = document.querySelector('.settings-nav [data-tab="claw"]');
  if (navBtn) navBtn.remove();
  const pane = document.querySelector('.settings-pane[data-pane="claw"]');
  if (pane) pane.remove();
});
