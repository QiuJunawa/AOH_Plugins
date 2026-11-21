/* ============================================================
   agent.js · 配置 + 模型通信 + Agent 循环
   关键设计：
   1. system 只放静态提示词，运行时上下文追加到最后一条 user（利于前缀缓存）；
   2. 流式期间只回调增量，不做任何 DOM 全量重建（渲染交给 chat.js 节流）；
   3. 工具调度：只读并行、写操作串行；同轮同文件禁止 write+edit 混用；
   4. 预算硬控（轮数/工具次数/墙钟/成本），超限时补齐 tool 响应，避免 400；
   5. 上下文超限自动收紧预算重试一次。
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const U = AH.util;

  /* ============================================================
     配置
     ============================================================ */
  const DEFAULT_SYSTEM = [
    '你叫小匣，是一个运行在浏览器里的 AI Agent。你有一个虚拟文件系统（VFS），只能通过工具读写它。',
    '',
    '## 工作原则',
    '1. 一律使用绝对路径（/ 开头）。不确定文件是否存在时，先 list_files 或 read_file，不要臆造路径和内容。',
    '2. 改代码优先 edit_file（唯一字符串替换）；整写前必须先 read_file。同一轮、同一个文件不要同时用 write_file 和 edit_file。',
    '3. 没有依赖的多个工具调用放在同一轮发出，系统会并行执行；有依赖的按顺序分轮。',
    '4. 删除、覆盖、移动、联网抓取前系统会弹窗确认；用户拒绝就停止该操作并说明。',
    '5. 工具报错先读错误原因、修正参数再重试；不要用相同参数盲目重试，也不要为了显得忙而空转调用工具。',
    '6. 需求不明确、需要用户决策时用 ask_user；复杂任务先用 todo_add 拆成 3-8 步。',
    '7. 收尾时在正文单独一行写 `[deliver:标题 | 描述 | /文件1, /文件2]`，系统会渲染成交付卡片；不要为此额外调用工具，节省一轮。',
    '8. 不要编造数字、日期、引用和“已完成”。不确定就直说不确定，并给出验证方法。',
    '9. 思考过程不会跨轮保留。计划、结论、用户决定、下一步动作必须写进正文或文件。',
    '10. 长文本可用 （引用格式错误：/路径:起始行-结束行） 引用 VFS 已有内容，避免重复输出，节省 token。',
    '11. 不要在文件里写 API Key、Token 或密码。',
    '12. 内置知识库在 /knowledge（先读 INDEX.md）。涉及自身能力、环境限制、工具用法或用户问“怎么用”时，先查对应文档；文档与工具结果冲突时以工具结果为准。',
    '13. 插件页有官方插件库（AOH_Plugins）。需要找/装插件时先 tools_expand(["plugin"])，再用 plugin_lib_list / plugin_lib_install；安装前必须让用户看清来源与代码摘录。',
    '14. 批量操作（读多个文件、批量改名、按规则处理目录）优先用 execute_script 一次完成，不要逐轮调用工具；脚本用 AgentAPI.call 调工具，纯计算用 run_js。',
    '15. execute_script 里的 AgentAPI.assert 是**对象不是函数**，只有 assert.exists(path) / assert.isFile(path) / assert.isDir(path) 三个方法，且都是**断言式**：满足时返回 undefined，不满足直接抛错（如「路径不存在：/x」「不是文件：/x」），靠抛错中断脚本即可当前置条件用。写成 AgentAPI.assert(条件, 说明) 会报 TypeError；需要自定义断言时自己写 `if (!条件) throw new Error("说明")`。',
  ].join('\n');

  const DEFAULTS = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    reasoning: '',
    agentMode: 'auto',
    systemPrompt: DEFAULT_SYSTEM,
    lazyTools: true,
    toolTimeoutSec: 120,
    maxCalls: 60,
    maxCost: 0,
    maxWall: 300,
    maxLoops: 16,
    maxOut: 0,
    memory: true,
    titleGen: true,
    proxy: '',
    gitPlatform: 'github',
    gitRepo: '',
    gitToken: '',
    gitBranch: '',
    theme: 'dark',
    fontSize: 15,
    fontUI: "'Comic Sans MS', 'Comic Neue', 'LXGW WenKai', 'Kaiti SC', serif",
    fontBody: "'Inter', 'Source Han Sans SC VF', 'Source Han Sans SC', 'Noto Sans SC', 'Noto Sans CJK SC', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
    compact: false,
    sendKey: 'enter',
    disabledTools: [],
    htmlCheckMs: 5000
  };

  const KEY = 'xiaohe_cfg_v1';
  const cfg = (AH.cfg = { data: { ...DEFAULTS }, _listeners: new Set() });

  cfg.load = function () {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        cfg.data = { ...DEFAULTS, ...obj };
        if (Array.isArray(cfg.data.disabledTools)) cfg.data.disabledTools = cfg.data.disabledTools.filter((n) => typeof n === 'string');
      }
    } catch (e) { console.warn('[cfg] 读取失败', e); }
    return cfg.data;
  };

  cfg.save = function () {
    try { localStorage.setItem(KEY, JSON.stringify(cfg.data)); }
    catch (e) { AH.ui && AH.ui.toast('设置保存失败（浏览器存储不可用）', 'err'); }
    for (const fn of cfg._listeners) { try { fn(cfg.data); } catch (e) {} }
  };

  cfg.get = (k) => cfg.data[k];
  cfg.set = (k, v) => { cfg.data[k] = v; cfg.save(); };
  cfg.patch = (obj) => { Object.assign(cfg.data, obj); cfg.save(); };
  cfg.on = (fn) => { cfg._listeners.add(fn); return () => cfg._listeners.delete(fn); };
  cfg.defaults = DEFAULTS;
  cfg.defaultSystem = DEFAULT_SYSTEM;

  /* ============================================================
     计费（粗略估算，仅用于预算提示）
     ============================================================ */
  function pricing(model) {
    const m = String(model || '').toLowerCase();
    if (/(glm-4\.?7-flash|glm-4-flash|glm-4\.?5-air|qwen-turbo)/.test(m)) return { in: 0, out: 0 };
    if (/deepseek/.test(m) && /(pro|v4-pro)/.test(m)) return { in: 1.25, out: 3.75 };
    if (/deepseek/.test(m) && /reasoner/.test(m)) return { in: 0.28, out: 2.22 };
    if (/deepseek/.test(m) && /(chat|v3)/.test(m)) return { in: 0.14, out: 0.56 };
    if (/deepseek/.test(m)) return { in: 0.28, out: 1.11 };
    if (/(gpt-4o-mini|gpt-3\.5)/.test(m)) return { in: 0.15, out: 0.6 };
    if (/gpt-4o/.test(m)) return { in: 2.5, out: 10 };
    if (/(gpt-4|o1|o3)/.test(m)) return { in: 10, out: 30 };
    if (/haiku/.test(m)) return { in: 0.25, out: 1.25 };
    if (/claude/.test(m)) return { in: 3, out: 15 };
    if (/qwen-max/.test(m)) return { in: 2.4, out: 7.2 };
    if (/qwen-plus/.test(m)) return { in: 0.8, out: 2 };
    if (/(kimi|moonshot)/.test(m)) return { in: 0.6, out: 2.4 };
    return { in: 0.5, out: 1.5 };
  }
  function costOf(model, inTok, outTok) {
    const p = pricing(model);
    return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
  }
  AH.agent = { pricing, costOf };

  /* ============================================================
     端点与请求体
     ============================================================ */
  function endpoint() {
    const base = String(cfg.get('baseUrl') || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('尚未配置 API Base URL（设置 → 模型）');
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  function isThinkingProvider() {
    const url = String(cfg.get('baseUrl') || '').toLowerCase();
    return /deepseek|bigmodel|zhipu|dashscope|aliyuncs/.test(url);
  }

  function buildPayload(messages, tools, opts) {
    const model = cfg.get('model');
    if (!model) throw new Error('尚未配置模型名称');
    const payload = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    };
    const reasoning = cfg.get('reasoning');
    if (reasoning === 'disabled') {
      payload.temperature = Number(cfg.get('temperature')) || 0;
      if (isThinkingProvider()) payload.thinking = { type: 'disabled' };
    } else if (reasoning) {
      payload.reasoning_effort = reasoning;
      if (isThinkingProvider()) payload.thinking = { type: 'enabled' };
    }
    const userMax = Math.max(0, parseInt(cfg.get('maxOut'), 10) || 0);
    if (userMax > 0) payload.max_tokens = Math.min(userMax, 200000);
    if (tools && tools.length) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }
    if (opts && opts.noStream) {
      delete payload.stream;
      delete payload.stream_options;
    }
    return payload;
  }

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    const key = String(cfg.get('apiKey') || '').trim();
    if (key) h['Authorization'] = 'Bearer ' + key;
    return h;
  }

  /* ============================================================
     消息清洗 / 裁剪
     ============================================================ */
  function cleanText(s) { return U.cleanSurrogates(String(s == null ? '' : s)); }

  function sanitize(messages) {
    const out = [];
    const openIds = new Set();
    for (const raw of messages) {
      if (!raw || !raw.role) continue;
      const m = { role: raw.role };
      if (raw.role === 'tool') {
        if (!raw.tool_call_id || !openIds.has(raw.tool_call_id)) continue;
        m.tool_call_id = raw.tool_call_id;
        m.content = cleanText(raw.content);
        out.push(m);
        openIds.delete(raw.tool_call_id);
        continue;
      }
      // 上一组 tool_calls 还没配齐就遇到新消息：补齐占位，避免 400
      if (openIds.size) {
        for (const id of [...openIds]) {
          out.push({ role: 'tool', tool_call_id: id, content: '（未执行：上下文已切换）' });
          openIds.delete(id);
        }
      }
      if (Array.isArray(raw.content)) {
        m.content = raw.content.map((p) => {
          if (!p || !p.type) return null;
          if (p.type === 'text') return { type: 'text', text: cleanText(p.text) };
          if (p.type === 'image_url' && p.image_url && p.image_url.url) return { type: 'image_url', image_url: { url: p.image_url.url } };
          return null;
        }).filter(Boolean);
      } else m.content = cleanText(raw.content);
      if (raw.tool_calls && raw.tool_calls.length) {
        m.tool_calls = raw.tool_calls.map((tc, i) => {
          const id = tc.id || 'call_' + Date.now().toString(36) + '_' + i;
          openIds.add(id);
          return { id, type: 'function', function: { name: tc.function && tc.function.name || '', arguments: cleanText(tc.function && tc.function.arguments || '{}') } };
        });
        if (cfg.get('reasoning') !== 'disabled') m.reasoning_content = '';
      } else if (!m.content && raw.role === 'assistant') {
        continue;
      }
      out.push(m);
    }
    for (const id of openIds) out.push({ role: 'tool', tool_call_id: id, content: '（未执行：本轮结束）' });
    return out;
  }

  function buildMessages(conv, dynamicParts, tighten) {
    const budget = (Number(cfg.get('contextTokens')) || 90000) * (tighten || 1);
    let total = 0;
    let cut = 0;
    for (let i = conv.length - 1; i >= 0; i--) {
      total += U.estimateMsgTokens(conv[i]);
      if (total > budget) { cut = i + 1; break; }
    }
    while (cut < conv.length && conv[cut] && (conv[cut].role === 'tool' || (conv[cut].role === 'assistant' && conv[cut].tool_calls))) cut++;
    const kept = conv.slice(cut);
    const dropped = cut;
    const messages = [{ role: 'system', content: cleanText(cfg.get('systemPrompt') || DEFAULT_SYSTEM) }, ...kept];
    if (dropped > 0) {
      dynamicParts.push('本次上下文已省略更早的 ' + dropped + ' 条消息（预算限制）。完整记录在对话存档，需要时用 read_file 查阅。');
    }
    const dyn = '<runtime_context>\n' + dynamicParts.filter(Boolean).join('\n') + '\n</runtime_context>';
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && !last.tool_calls) {
      if (typeof last.content === 'string') messages[messages.length - 1] = { role: 'user', content: last.content + '\n\n' + dyn };
      else if (Array.isArray(last.content)) messages[messages.length - 1] = { role: 'user', content: [...last.content, { type: 'text', text: '\n\n' + dyn }] };
      else messages.push({ role: 'user', content: dyn });
    } else {
      messages.push({ role: 'user', content: dyn });
    }
    return sanitize(messages);
  }

  /* ============================================================
     流式请求
     ============================================================ */
  async function streamChat(run) {
    const conv = run.conv;
    const signal = run.signal;
    if (signal && signal.aborted) throw new Error('__STOPPED__');

    const tools = run.useTools ? AH.tools.buildSpecs(run) : null;

    // 运行时上下文：全部放在 messages 末尾，system 保持稳定
    const dynamicParts = [];
    dynamicParts.push('当前时间：' + U.nowText());
    dynamicParts.push('当前模型：' + cfg.get('model') + '（以这个身份回答，不要自称其他品牌模型）');
    if (run.session && run.session.filePath) dynamicParts.push('本对话存档：' + run.session.filePath + '（需要回顾更早内容时用 read_file 读取）');
    if (run.memHits && run.memHits.length) {
      dynamicParts.push('可能相关的长期记忆：\n' + run.memHits.map((x, i) => (i + 1) + '. ' + x.m.text).join('\n'));
    }
    if (run.useTools) {
      dynamicParts.push('本轮为 Agent 模式：可以调用工具；工具结果会以 role=tool 回灌。后续没有依赖的调用请合并到同一轮。');
      if (cfg.get('lazyTools')) dynamicParts.push('工具是懒加载的：当前只下发了核心文件工具。需要联网/计算/图表等能力时，先调用 tools_expand 展开分组。');
    } else {
      dynamicParts.push('本轮为纯聊天模式：没有工具可用，不要尝试调用工具。');
    }
    if (run.vision === false) dynamicParts.push('当前模型按文本处理；图片不会以 image_url 传入。');
    if (run.attachments && run.attachments.length) {
      dynamicParts.push('用户附带文件：\n' + run.attachments.map((a) => '- ' + a.path + (a.isDir ? '（目录）' : a.isImage ? '（图片）' : '（已存入 VFS，可 read_file）')).join('\n'));
    }

    const messages = buildMessages(conv, dynamicParts, run.tighten);
    const payload = buildPayload(messages, tools);

    if (run.hooks && run.hooks.status) run.hooks.status(tools ? '正在请求模型（Agent 模式）…' : '正在请求模型…');

    let resp;
    const ctrl = new AbortController();
    const connectTimer = setTimeout(() => ctrl.abort(), 120000);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    const t0 = Date.now();
    try {
      resp = await fetch(endpoint(), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(connectTimer);
      if (e.name === 'AbortError') {
        if (signal && signal.aborted) throw new Error('__STOPPED__');
        throw new Error('请求超时（2 分钟没有响应）');
      }
      throw new Error('网络请求失败：' + (e && e.message || e) + '\n可能是 Base URL 不正确，或服务商不允许浏览器直连（CORS）。');
    }
    clearTimeout(connectTimer);

    if (!resp.ok) {
      let detail = '';
      try { detail = await resp.text(); } catch (e) {}
      let hint = '';
      if (resp.status === 401) hint = '\n→ 检查 API Key 是否正确、是否过期。';
      else if (resp.status === 404) hint = '\n→ 检查 Base URL（是否少了 /v1）与模型名称。';
      else if (resp.status === 429) hint = '\n→ 触发限流或额度不足，稍后重试。';
      throw new Error('API 返回 ' + resp.status + ' ' + resp.statusText + hint + '\n' + U.cut(detail, 800));
    }

    if (run.hooks && run.hooks.status) run.hooks.status('正在接收回复…');

    /* 非流式兜底（某些代理不返回 body 流） */
    if (!resp.body) {
      const raw = await resp.text();
      let j;
      try { j = JSON.parse(raw); } catch (e) { throw new Error('解析响应失败：' + U.cut(raw, 500)); }
      if (j.error) throw new Error('API 错误：' + (j.error.message || JSON.stringify(j.error)));
      const choice = j.choices && j.choices[0];
      if (!choice || !choice.message) throw new Error('API 返回了空响应');
      const msg = choice.message;
      const calls = (msg.tool_calls || []).map((tc, i) => ({
        id: tc.id || 'call_' + t0.toString(36) + '_' + i,
        type: 'function',
        function: { name: tc.function && tc.function.name || '', arguments: tc.function && tc.function.arguments || '{}' }
      }));
      if (run.hooks && run.hooks.delta) run.hooks.delta(msg.content || '', msg.reasoning_content || '');
      return { content: msg.content || '', thinking: msg.reasoning_content || '', toolCalls: calls, usage: j.usage || null, finishReason: choice.finish_reason || null };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const stashPartial = () => {
      if (content.trim() || thinking.trim()) {
        const msg = { role: 'assistant', content };
        if (thinking) msg._thinking = thinking;
        run.conv.push(msg);
      }
    };
    let buffer = '';
    let content = '';
    let thinking = '';
    let usage = null;
    let finishReason = null;
    let sawDone = false;
    let gotData = false;
    const toolAcc = [];
    const READ_IDLE = 90000;

    const flushLines = (lines) => {
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        gotData = true;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { sawDone = true; continue; }
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) throw new Error('API 错误：' + (j.error.message || JSON.stringify(j.error)));
        if (j.usage) usage = j.usage;
        const ch = j.choices && j.choices[0];
        if (!ch) continue;
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const d = ch.delta || {};
        if (d.reasoning_content) {
          thinking += d.reasoning_content;
          if (run.hooks && run.hooks.delta) run.hooks.delta(content, thinking);
        }
        if (d.content) {
          let piece = d.content;
          if (Array.isArray(piece)) piece = piece.map((p) => (p && p.text) || '').join('');
          content += piece;
          if (run.hooks && run.hooks.delta) run.hooks.delta(content, thinking);
        }
        if (d.tool_calls) {
          for (const tc of d.tool_calls) {
            const idx = tc.index != null ? tc.index : 0;
            if (!toolAcc[idx]) toolAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            const slot = toolAcc[idx];
            if (tc.id) slot.id = tc.id;
            if (tc.function) {
              if (tc.function.name) slot.function.name = String(tc.function.name);
              if (tc.function.arguments) slot.function.arguments += String(tc.function.arguments);
            }
            if (run.hooks && run.hooks.toolDelta) run.hooks.toolDelta(idx, slot.function.name, slot.function.arguments);
          }
        }
        if (j.usage && run.hooks && run.hooks.usage) run.hooks.usage(j.usage);
      }
    };

    let abortReject = null;
    const abortPromise = new Promise((_, rej) => { abortReject = rej; });
    abortPromise.catch(() => {});
    if (signal) signal.addEventListener('abort', () => abortReject(new Error('__ABORT__')), { once: true });
    while (true) {
      if (signal && signal.aborted) {
        stashPartial();
        try { reader.cancel(); } catch (e) {}
        throw new Error('__STOPPED__');
      }
      let result;
      let idleTimer = null;
      try {
        result = await Promise.race([
          reader.read(),
          abortPromise,
          new Promise((_, rej) => { idleTimer = setTimeout(() => rej(new Error('__IDLE__')), READ_IDLE); })
        ]);
        clearTimeout(idleTimer);
      } catch (e) {
        clearTimeout(idleTimer);
        if (signal && signal.aborted) {
          stashPartial();
          throw new Error('__STOPPED__');
        }
        if (e.message === '__IDLE__') {
          content += '\n\n[⚠ 流式读取超时：90 秒没有收到数据，已保留现有内容]';
          break;
        }
        if (e.message === '__ABORT__') throw new Error('__STOPPED__');
        throw e;
      }
      const { done, value } = result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      flushLines(lines);
    }

    if (buffer.trim()) {
      if (!gotData) {
        // 整体 JSON 兜底
        try {
          const j = JSON.parse(buffer.trim());
          const ch = j.choices && j.choices[0];
          if (ch && ch.message) {
            content = ch.message.content || content;
            thinking = ch.message.reasoning_content || thinking;
            (ch.message.tool_calls || []).forEach((tc, i) => {
              toolAcc[i] = { id: tc.id || '', type: 'function', function: { name: tc.function && tc.function.name || '', arguments: tc.function && tc.function.arguments || '{}' } };
            });
            usage = j.usage || usage;
          }
        } catch (e) { /* 忽略 */ }
      } else flushLines([buffer]);
    }

    const calls = toolAcc.filter(Boolean).map((tc, i) => ({
      id: tc.id || 'call_' + t0.toString(36) + '_' + i,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments || '{}' }
    })).filter((tc) => tc.function.name);

    // 去重（部分代理会重发同一段流）
    const seen = new Set();
    const unique = [];
    for (const tc of calls) {
      const sig = tc.id + '|' + tc.function.name + '|' + tc.function.arguments;
      if (seen.has(sig)) continue;
      seen.add(sig); unique.push(tc);
    }

    let diag = '';
    if (finishReason === 'length') diag = '\n\n[⚠ 输出达到 max_tokens 上限被截断，可在设置里调大输出上限]。';
    else if (finishReason === 'content_filter') diag = '\n\n[⚠ 输出被内容过滤中断]。';
    else if (gotData && !sawDone && !finishReason) diag = '\n\n[⚠ 流被提前关闭（未收到 [DONE]），已保留现有内容]。';
    if (diag) content += diag;

    if (!content.trim() && !unique.length && !thinking.trim()) {
      throw new Error('API 返回空响应（无正文、无工具调用）。检查模型名称、Base URL 或该模型是否支持 stream。');
    }

    return { content, thinking, toolCalls: unique, usage, finishReason };
  }

  AH.agent.streamChat = streamChat;

  /* ============================================================
     工具调度
     ============================================================ */
  async function executeBatch(run, toolCalls, emit) {
    const results = new Map();
    const readOnly = [];
    const writes = [];
    const blocked = new Set();

    // 同轮同文件 write + edit 混用：整写会抹掉编辑，直接拦截
    const writePaths = new Set();
    const editPaths = new Set();
    for (const tc of toolCalls) {
      try {
        const a = JSON.parse(tc.function.arguments || '{}');
        if (['write_file', 'append_file'].includes(tc.function.name)) writePaths.add(U.normPath(a.path || ''));
        if (tc.function.name === 'edit_file') editPaths.add(U.normPath(a.path || ''));
      } catch (e) {}
    }
    for (const p of writePaths) {
      if (!editPaths.has(p)) continue;
      for (const tc of toolCalls) {
        try {
          const a = JSON.parse(tc.function.arguments || '{}');
          if (U.normPath(a.path || '') === p && ['write_file', 'append_file', 'edit_file'].includes(tc.function.name)) blocked.add(tc.id);
        } catch (e) {}
      }
    }

    for (const tc of toolCalls) {
      if (AH.tools.isReadOnly(tc.function.name) && !blocked.has(tc.id)) readOnly.push(tc);
      else writes.push(tc);
    }

    const ctxFor = (tc) => ({
      run,
      signal: run.signal,
      callId: tc.id,
      confirm: (o) => AH.ui.confirm(o)
    });

    const execOne = async (tc) => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {
        const msg = '工具参数不是合法 JSON：' + U.cut(tc.function.arguments, 200);
        emit.finish(tc.id, false, msg);
        results.set(tc.id, msg);
        return;
      }
      if (blocked.has(tc.id)) {
        const msg = '⚠️ 调度层拦截：同一轮内对同一文件同时使用 write_file / edit_file。请拆成两轮。';
        emit.finish(tc.id, false, msg);
        results.set(tc.id, msg);
        return;
      }
      if (run.signal && run.signal.aborted) {
        results.set(tc.id, '用户已停止');
        emit.finish(tc.id, false, '用户已停止');
        return;
      }
      emit.start(tc.id, args);
      const started = performance.now();
      const timeoutMs = Math.max(10000, Number(cfg.get('toolTimeoutSec')) || 120) * 1000;
      const NO_BG = new Set(['read_file', 'list_files', 'search_files', 'todo_list', 'task_status', 'undo_list', 'tools_expand', 'wait', 'run_js', 'check_code']);
      let outcome;
      try {
        const exec = AH.tools.execute(tc.function.name, args, ctxFor(tc));
        if (NO_BG.has(tc.function.name)) {
          outcome = await exec;
        } else {
          let timer;
          let onAbort = null;
          outcome = await Promise.race([
            exec,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve('__TIMEOUT__'), timeoutMs);
              if (run.signal) {
                onAbort = () => { clearTimeout(timer); resolve('__ABORTED__'); };
                run.signal.addEventListener('abort', onAbort, { once: true });
              }
            })
          ]);
          clearTimeout(timer);
          if (onAbort && run.signal) run.signal.removeEventListener('abort', onAbort);
          if (outcome === '__TIMEOUT__') {
            const taskId = AH.taskRegistry.start(tc.function.name, args);
            const rec = AH.taskRegistry.map.get(taskId);
            if (rec && run.session) rec.sessionId = run.session.id;
            exec.then((r) => AH.taskRegistry.finish(taskId, r)).catch((e) => AH.taskRegistry.finish(taskId, '', e));
            outcome = '⏳ 工具 ' + tc.function.name + ' 超过 ' + Math.round(timeoutMs / 1000) + ' 秒，已转后台运行。\n任务 ID：' + taskId + '\n稍后用 task_status 查询。';
          } else if (outcome === '__ABORTED__') {
            outcome = '用户已停止';
          }
        }
        results.set(tc.id, String(outcome == null ? '' : outcome));
        emit.finish(tc.id, true, results.get(tc.id), performance.now() - started);
      } catch (e) {
        const msg = '工具执行失败：' + (e && e.message ? e.message : e);
        results.set(tc.id, msg);
        emit.finish(tc.id, false, msg, performance.now() - started);
      }
    };

    // 只读并行（并发 4），写操作严格串行
    const RO_CONCURRENCY = 4;
    let roIndex = 0;
    const workers = Array.from({ length: Math.min(RO_CONCURRENCY, readOnly.length) }, async () => {
      while (roIndex < readOnly.length) {
        const tc = readOnly[roIndex++];
        await execOne(tc);
      }
    });
    await Promise.all(workers);
    for (const tc of writes) await execOne(tc);

    return toolCalls.map((tc) => ({ tc, result: results.get(tc.id) || '（无结果）' }));
  }

  AH.agent.executeBatch = executeBatch;

  /* ============================================================
     Agent 循环
     ============================================================ */
  async function runAgent(run) {
    const conv = run.conv;
    const maxLoops = Math.max(1, Number(cfg.get('maxLoops')) || 16);
    const budget = { start: Date.now(), calls: 0, inTok: 0, outTok: 0, cost: 0 };
    AH.tools.UNDO.begin();
    let loops = 0;
    let lastRound = null;

    while (loops < maxLoops) {
      if (run.signal && run.signal.aborted) throw new Error('__STOPPED__');

      // 预算检查（在新请求之前，确保没有待配对的工具调用）
      const over = checkBudget(budget);
      if (over.length) {
        await settleDanglingTools(conv, '预算超限，未执行');
        AH.tools.UNDO.commit();
        run.hooks.error('⛔ 已停止：' + over.join('；') + '。本轮完成 ' + loops + ' 次模型调用。');
        return;
      }

      loops++;
      if (run.hooks.roundStart) run.hooks.roundStart(loops);
      let round;
      let overflowRetried = false;
      while (!round) {
        try {
          round = await streamChat(run);
        } catch (e) {
          if (e.message === '__STOPPED__') throw e;
          if (!overflowRetried && isOverflow(e)) {
            overflowRetried = true;
            run.tighten = (run.tighten || 1) * 0.55;
            run.hooks.error('⚠ 上下文超限，已临时收紧本轮上下文预算后重试一次。');
            continue;
          }
          throw e;
        }
      }
      lastRound = round;

      if (round.usage) {
        const inTok = round.usage.prompt_tokens || round.usage.input_tokens || 0;
        const outTok = round.usage.completion_tokens || round.usage.output_tokens || 0;
        budget.inTok += inTok;
        budget.outTok += outTok;
        budget.cost += costOf(cfg.get('model'), inTok, outTok);
        run.usage = run.usage || { inTok: 0, outTok: 0, cost: 0 };
        run.usage.inTok += inTok;
        run.usage.outTok += outTok;
        run.usage.cost += costOf(cfg.get('model'), inTok, outTok);
        if (run.hooks.usage) run.hooks.usage(run.usage);
      }

      const content = round.content || '';
      const toolCalls = round.toolCalls || [];

      if (toolCalls.length) {
        const cleanCalls = toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments || '{}' } }));
        const assistantMsg = { role: 'assistant', content, tool_calls: cleanCalls };
        if (round.thinking) assistantMsg._thinking = round.thinking;
        conv.push(assistantMsg);

        budget.calls += toolCalls.length;
        run.hooks.assistantDone(content, round.thinking);

        if (run.hooks.toolsReady) run.hooks.toolsReady(toolCalls);
        const results = await executeBatch(run, toolCalls, {
          start: (id, args) => run.hooks.toolStart && run.hooks.toolStart(id, args),
          finish: (id, ok, text, ms) => run.hooks.toolFinish && run.hooks.toolFinish(id, ok, text, ms)
        });

        for (const r of results) {
          const text = await trimToolResult(r.result, conv);
          conv.push({ role: 'tool', tool_call_id: r.tc.id, content: text });
        }

        if (run.awaitUser) break;

        if (run.signal && run.signal.aborted) throw new Error('__STOPPED__');
        continue;
      }

      // 没有工具调用：本轮结束
      const msg = { role: 'assistant', content };
      if (round.thinking) msg._thinking = round.thinking;
      conv.push(msg);
      run.hooks.assistantDone(content, round.thinking);
      break;
    }

    if (loops >= maxLoops && !run.awaitUser) {
      run.hooks.error('⚠ 达到最大工具循环次数（' + maxLoops + '），任务可能未完成。可在设置 → Agent 调大。');
    }
    AH.tools.UNDO.commit();
  }

  function checkBudget(b) {
    const over = [];
    const maxCalls = Number(cfg.get('maxCalls')) || 0;
    if (maxCalls > 0 && b.calls >= maxCalls) over.push('工具调用达上限 ' + maxCalls);
    const maxWall = Number(cfg.get('maxWall')) || 0;
    if (maxWall > 0 && (Date.now() - b.start) / 1000 >= maxWall) over.push('耗时达上限 ' + maxWall + 's');
    const maxCost = Number(cfg.get('maxCost')) || 0;
    if (maxCost > 0 && b.cost >= maxCost) over.push('成本达上限 $' + maxCost);
    return over;
  }

  function isOverflow(e) {
    const s = String(e && e.message || e).toLowerCase();
    return /context length|context_length|too long|maximum context|上下文超|token.*(超过|上限)/.test(s) && !/401|403|404|429/.test(s);
  }

  async function settleDanglingTools(conv, text) {
    const declared = new Set();
    for (const m of conv) {
      if (m.role === 'assistant' && m.tool_calls) m.tool_calls.forEach((tc) => declared.add(tc.id));
      if (m.role === 'tool') open.delete(m.tool_call_id);
    }
    for (const id of declared) if (!conv.some((m) => m.role === 'tool' && m.tool_call_id === id)) conv.push({ role: 'tool', tool_call_id: id, content: text });
  }

  /* 工具结果入上下文前压缩 + 去重 */
  const resultSeen = new Map();
  async function trimToolResult(text, conv) {
    const s = String(text == null ? '' : text);
    if (s.length <= 30000) return s;
    const head = U.cut(s, 22000);
    const tail = s.slice(-6000);
    const pruned = head + '\n\n…（工具结果过长，中间已省略 ' + (s.length - 28000) + ' 字符）…\n\n' + tail;
    // 完全相同的大结果只保留一次，其余用占位符（避免重复读同一文件烧 token）
    if (s.length > 3000) {
      const h = U.hash(s);
      const prev = resultSeen.get(h);
      if (prev != null) return '[与第 ' + prev + ' 条工具结果完全相同，已省略]';
      resultSeen.set(h, conv.filter((m) => m.role === 'tool').length + 1);
    }
    return pruned;
  }

  /* ============================================================
     标题生成（一次小请求）
     ============================================================ */
  async function generateTitle(session) {
    if (!cfg.get('titleGen')) return null;
    const conv = Array.isArray(session) ? session : (session && session.conv) || [];
    const text = conv.filter((m) => m.role === 'user').slice(0, 1).map((m) => typeof m.content === 'string' ? m.content : '').join('').trim();
    if (!text) return null;
    const key = String(cfg.get('apiKey') || '').trim();
    if (!key) return null;
    try {
      const payload = {
        model: cfg.get('model'),
        messages: [
          { role: 'system', content: '你是标题生成器。只输出一个不超过 14 个汉字的中文标题，不要引号、句号或解释。' },
          { role: 'user', content: U.cut(text, 600) }
        ],
        max_tokens: 40,
        temperature: 0.2,
        stream: false
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const resp = await fetch(endpoint(), { method: 'POST', headers: headers(), body: JSON.stringify(payload), signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const j = await resp.json();
      let title = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
      title = title.replace(/["“”'《》\n\r]/g, '').trim().replace(/[。.!！?？:：]$/, '');
      if (!title) return null;
      return U.cut(title, 18);
    } catch (e) { return null; }
  }

  AH.agent.run = runAgent;
  AH.agent.generateTitle = generateTitle;
  AH.agent.DEFAULT_SYSTEM = DEFAULT_SYSTEM;
})();
