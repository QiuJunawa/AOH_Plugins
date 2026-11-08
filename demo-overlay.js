/* demo-overlay 示例插件
 * - 在页面右下角/顶部加一个不拦截鼠标的浮层
 * - 演示 defineTool 的多工具注册、DOM 注入与 onUnload 清理
 */

let overlayEl = null;

function ensureOverlay(text) {
  if (!overlayEl) {
    overlayEl = document.createElement('div');
    overlayEl.id = 'aoh-overlay-' + AgentAPI.pluginId;
    overlayEl.style.cssText = [
      'position:fixed',
      'left:12px',
      'bottom:12px',
      'z-index:2147483647',
      'padding:6px 10px',
      'border-radius:6px',
      'background:rgba(20,20,20,0.72)',
      'color:#fff',
      'font:12px/1.4 -apple-system,Segoe UI, sans-serif',
      'pointer-events:none',
      'user-select:none',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)'
    ].join(';');
    document.body.appendChild(overlayEl);
  }
  overlayEl.textContent = text;
  overlayEl.style.display = '';
}

AgentAPI.defineTool('overlay_show', {
  description: '在页面左下角显示一个不拦截鼠标的小浮层。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要显示的文字，默认 "overlay"' }
    }
  }
}, async (args) => {
  ensureOverlay(String((args && args.text) || 'overlay'));
  return 'overlay shown: ' + overlayEl.textContent;
});

AgentAPI.defineTool('overlay_hide', {
  description: '隐藏浮层。',
  parameters: { type: 'object', properties: {} }
}, async () => {
  if (overlayEl) overlayEl.style.display = 'none';
  return 'overlay hidden';
});

AgentAPI.defineTool('overlay_status', {
  description: '查询浮层当前是否可见。',
  parameters: { type: 'object', properties: {} }
}, async () => {
  return { visible: !!(overlayEl && overlayEl.style.display !== 'none'), text: overlayEl ? overlayEl.textContent : '' };
});

onUnload(() => {
  if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
  overlayEl = null;
});

AgentAPI.toast('demo-overlay 插件已加载');
