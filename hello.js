/* Hello 示例插件
 * - 用 AgentAPI.defineTool(name, spec, handler) 注册工具
 * - 用 onUnload(fn) 注册清理函数，禁用/重载/删除时自动执行
 * - 外层是 AsyncFunction，内部可直接 await
 */

AgentAPI.defineTool('hello_greet', {
  description: '按名字打招呼。示例工具。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '要打招呼的对象' },
      loud: { type: 'boolean', description: '可选，是否全大写' }
    },
    required: ['name']
  }
}, async (args) => {
  const who = String((args && args.name) || '世界').trim() || '世界';
  let msg = '你好，' + who + '！来自 ' + AgentAPI.pluginId + ' 插件';
  if (args && args.loud) msg = msg.toUpperCase();
  return msg;
});

// 有定时器/监听器/DOM 时必须注册清理，否则禁用插件后还留着
const timer = setInterval(() => {}, 60000);
onUnload(() => clearInterval(timer));

AgentAPI.toast('hello 插件已加载');
