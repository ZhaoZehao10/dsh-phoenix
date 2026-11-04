// ★ P-278b：check_all.mjs 跑后复查四分支的真值表验证。
//   逐字复刻 check_all.mjs 里的分支逻辑，喂各种真实/合成 --list 输出形态。
function classify(listOut) {
  if (!listOut.trim()) return 'no-output'
  if (listOut.includes('没有 bge_embed_server')) return 'none'
  if (!listOut.includes('🔴')) return 'live-only'
  return 'orphan'
}

const none = '  ✅ 没有 bge_embed_server 进程\n'
const liveOnly = [
  '  共 2 个 bge_embed_server 进程（orphan=父进程已死）：',
  '    pid=33428   ppid=100     🟢 父进程存活',
  '    pid=49308   ppid=101     🟢 父进程存活',
].join('\n')
const orphan = [
  '  共 1 个 bge_embed_server 进程（orphan=父进程已死）：',
  '    pid=52000   ppid=999     🔴 孤儿',
].join('\n')

let fails = 0
function check(name, ok) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name)
  if (!ok) fails++
}

check('无服务 → none', classify(none) === 'none')
check('只有父进程存活的服务 → live-only', classify(liveOnly) === 'live-only')
check('有孤儿 → orphan', classify(orphan) === 'orphan')
check('空输出（embed_guard 崩了）→ no-output，不妄下结论',
      classify('') === 'no-output')
check('纯空白输出 → no-output', classify('  \n  ') === 'no-output')
// 回归：确认旧逻辑（includes('bge_embed_server') 先判）确实会误判 —— 守住修过的坑
const oldLogicWouldMiss = !none.includes('bge_embed_server')
check('回归锚点：旧逻辑对「无服务」确实失配（证明此修复必要）', !oldLogicWouldMiss)

console.log(fails ? `❌ ${fails} 项失败` : '✅ 四分支真值表全部通过')
process.exit(fails ? 1 : 0)
