// ★ 统一路径解析：让整套工具与测试在任何机器、任何用户名下可直接运行。
//
// 优先级：环境变量 > 自动探测 > 报错（绝不猜别的盘/别的用户）。
//   DSH_INSTALL_DIR  DeepSeek Harness 安装目录
//                    （默认 %LOCALAPPDATA%\Programs\DeepSeek Harness）
//   DSH_WORK_DIR     产物目录（默认 <bundle>/work，自动创建）
//   NODE_EXE / PY_EXE  指定解释器（默认：优先 DSH 自带运行时，退回当前进程解释器）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function detectInstallDir() {
  if (process.env.DSH_INSTALL_DIR) return process.env.DSH_INSTALL_DIR;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const guess = path.join(local, 'Programs', 'DeepSeek Harness');
  return guess;
}

export const INSTALL_DIR = detectInstallDir();
export const EXE = path.join(INSTALL_DIR, 'DeepSeek Harness.exe');
export const ASAR = path.join(INSTALL_DIR, 'resources', 'app.asar');

export const WORK_DIR = process.env.DSH_WORK_DIR || path.join(BUNDLE_ROOT, 'work');
fs.mkdirSync(WORK_DIR, { recursive: true });

// 产物：现场重建的补丁 asar（不必从别的机器搬 174MB 二进制）
export const PATCHED_ASAR = path.join(WORK_DIR, 'app.asar.patched');
export const TESTVARIANT_ASAR = path.join(WORK_DIR, 'app.asar.test-variant');

function firstExisting(cands) { return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }); }

// 解释器：优先 DSH 自带运行时（版本与应用一致），否则用当前 node
export const RUNTIME_BASE = path.join(INSTALL_DIR, 'resources', 'runtime', 'primary-runtime', 'dependencies');
export const NODE_EXE = process.env.NODE_EXE
  || firstExisting([path.join(RUNTIME_BASE, 'node', 'bin', 'node.exe')])
  || process.execPath;
export const PY_EXE = process.env.PY_EXE
  || firstExisting([path.join(RUNTIME_BASE, 'python', 'python.exe')]);

export function assertRuntime() {
  const errs = [];
  if (!fs.existsSync(ASAR)) errs.push(`找不到 app.asar：${ASAR}`);
  if (!fs.existsSync(EXE)) errs.push(`找不到主程序：${EXE}`);
  if (!NODE_EXE) errs.push('找不到可用的 node 解释器');
  return errs;
}
export function describe() {
  return { BUNDLE_ROOT, INSTALL_DIR, ASAR, WORK_DIR, NODE_EXE, PY_EXE: PY_EXE || '(未找到 python)' };
}
