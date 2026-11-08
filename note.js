/* page-tab 插件：往左侧导航栏注入一个自定义标签页（便签）
 * 做法：注入 CSS + 新建 section + 新建 nav 按钮，全部可被 onUnload 完全撤销
 */

const TAB_ID = 'plaintab';
const TAB_TITLE = '便签';
const NOTE_KEY = 'plugin_plaintab_note';
const ICON = '<svg class="ico-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H5.2L4 17.2z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="13" y2="12"/></svg>';

function cleanupTab() {
  const b = document.querySelector('.nav-rail-btn[data-mode="' + TAB_ID + '"]');
  if (b) b.remove();
  const p = document.getElementById('pluginTabPage');
  if (p) p.remove();
  const s = document.getElementById('pluginTabStyle');
  if (s) s.remove();
}
cleanupTab();   // 幂等：重复加载时先清掉上一次注入的痕迹

/* 1. 样式：让新 page 在对应 data-mode 下显示，同时藏掉其他页面的三栏 */
const style = document.createElement('style');
style.id = 'pluginTabStyle';
style.textContent = [
  '.' + TAB_ID + '-page { display: none; }',
  'body[data-mode="' + TAB_ID + '"] .' + TAB_ID + '-page { display: flex; flex: 1; min-width: 0; flex-direction: column; background: var(--bg-main); }',
  'body[data-mode="' + TAB_ID + '"] .sidebar,',
  'body[data-mode="' + TAB_ID + '"] .chat,',
  'body[data-mode="' + TAB_ID + '"] .editor,',
  'body[data-mode="' + TAB_ID + '"] .tools-page,',
  'body[data-mode="' + TAB_ID + '"] .plugins-page { display: none !important; }'
].join('\n');
/* 用 textContent 拼接而非模板字符串，避免 ${} 在宿主环境被误解析 */
document.head.appendChild(style);

/* 2. 页面本体 */
const page = document.createElement('section');
page.id = 'pluginTabPage';
page.className = TAB_ID + '-page';
page.innerHTML =
  '<div class="page-header">' +
    '<span class="ph-title">' + ICON + TAB_TITLE + '</span>' +
    '<span style="font-size:12px;color:var(--text-muted);font-weight:400">由插件 page-tab 注入的标签页</span>' +
  '</div>' +
  '<div class="page-body" style="padding:18px;display:flex;flex-direction:column;gap:10px;overflow:auto">' +
    '<textarea id="pluginTabNote" placeholder="在这里随手记点什么，内容存在 localStorage，不会进 VFS。" ' +
      'style="flex:1;min-height:280px;background:var(--bg-panel);border:1px solid var(--border);border-radius:8px;padding:12px;' +
      'color:var(--text-primary);font-family:ui-monospace,monospace;font-size:13px;line-height:1.6;resize:vertical"></textarea>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="ghost-btn" id="pluginTabSave" type="button">保存</button>' +
      '<span id="pluginTabHint" style="font-size:12px;color:var(--text-muted)"></span>' +
    '</div>' +
  '</div>';
document.querySelector('.app').appendChild(page);

/* 3. 导航按钮（接在「插件」后面） */
const nav = document.querySelector('.nav-rail');
const btn = document.createElement('button');
btn.type = 'button';
btn.className = 'nav-rail-btn';
btn.dataset.mode = TAB_ID;
btn.title = TAB_TITLE;
btn.setAttribute('aria-label', TAB_TITLE);
btn.innerHTML = ICON;
nav.appendChild(btn);

function openTab() {
  if (typeof switchPage === 'function') switchPage(TAB_ID);
  else document.body.dataset.mode = TAB_ID;   // 兜底：switchPage 不在全局时直接改 data-mode
}
btn.addEventListener('click', openTab);

/* 4. 便签读写 */
const ta = page.querySelector('#pluginTabNote');
const hint = page.querySelector('#pluginTabHint');
function readNote() {
  try { return localStorage.getItem(NOTE_KEY) || ''; } catch (e) { return ''; }
}
function writeNote(text) {
  try { localStorage.setItem(NOTE_KEY, text); return true; } catch (e) { return false; }
}
ta.value = readNote();
page.querySelector('#pluginTabSave').addEventListener('click', () => {
  hint.textContent = writeNote(ta.value) ? '已保存' : '保存失败（localStorage 不可用）';
});

/* 5. 注册给 AI 的工具 */
AgentAPI.defineTool('tab_open', {
  description: '切换到插件注入的「便签」标签页。',
  parameters: { type: 'object', properties: {} }
}, async () => {
  openTab();
  return '已切换到「' + TAB_TITLE + '」标签页';
});

AgentAPI.defineTool('tab_note', {
  description: '读取或写入「便签」标签页里的内容（存在 localStorage，不在 VFS 里）。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'get 读取 / set 写入' },
      text: { type: 'string', description: 'action=set 时要写入的内容' }
    },
    required: ['action']
  }
}, async (args) => {
  const a = String((args && args.action) || 'get').toLowerCase();
  if (a === 'set') {
    const t = (args && args.text != null) ? String(args.text) : '';
    if (!writeNote(t)) return '写入失败：localStorage 不可用';
    if (ta) ta.value = t;
    return '已写入便签（' + t.length + ' 字符）';
  }
  const cur = readNote();
  return cur ? cur : '（便签是空的）';
});

/* 6. 卸载时彻底还原：切回对话页、移除按钮/页面/样式 */
onUnload(() => {
  if (document.body.dataset.mode === TAB_ID) {
    if (typeof switchPage === 'function') switchPage('chat');
    else document.body.dataset.mode = 'chat';
  }
  cleanupTab();
});

AgentAPI.toast('page-tab 已加载：左侧导航新增「便签」标签页');
