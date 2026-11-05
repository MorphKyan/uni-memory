// 仅注入本地规则；不访问网络、凭据或会话历史。
const fs = require('node:fs');
const path = require('node:path');
let input = '';
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  try {
    const data = JSON.parse(input.replace(/^\uFEFF/, ''));
    const event = data.hook_event_name;
    if (event !== 'SubagentStart' && !(event === 'SessionStart' && ['startup', 'clear', 'compact'].includes(data.source))) return;
    const policy = fs.readFileSync(path.join(__dirname, '../skills/shared-memory/SKILL.md'), 'utf8')
      .replace(/^---[\s\S]*?---\s*/, '').replace('<!-- uni-memory:skill -->', '').trim();
    const context = '共享记忆规则已加载。按当前任务需要使用 uni_memory；先确认分区，缺少背景时读取 memory_context 并按需检索。不要因启动事件重复保存事实，也不要把父任务的分区盲目用于子任务。\n\n' + policy;
    fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
  } catch { /* 规则缺失或输入无效时退出，不阻塞宿主。 */ }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 65536) process.exit(0);
});
process.stdin.on('end', () => { finish(); process.exit(0); });
process.stdin.on('error', () => process.exit(0));
setTimeout(() => process.exit(0), 1000);
