import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { PATHS, ensureDataDirs } from './paths.mjs';

const CANDIDATE_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * 检测本机可用的 Chromium 系浏览器（用于离线 PDF 生成与独立登录态打开）
 */
export function detectBrowserExecutable() {
  for (const exe of CANDIDATE_BROWSERS) {
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

/**
 * 构建目标岗位打开链接：有原始 URL 直接打开，没有则按平台构造检索页
 */
export function resolveTargetUrl(job) {
  const rawUrl = String(job?.url || '').trim();
  if (rawUrl && /^https?:\/\//i.test(rawUrl)) return rawUrl;

  const keyword = encodeURIComponent(`${job?.company || ''} ${job?.title || ''}`.trim());
  const platform = String(job?.platform || '');
  if (platform.includes('猎聘')) {
    return `https://www.liepin.com/zhaopin/?key=${keyword}`;
  }
  if (platform.includes('智联')) {
    return `https://sou.zhaopin.com/?kw=${keyword}`;
  }
  // 默认 Boss 直聘
  return keyword
    ? `https://www.zhipin.com/web/geek/job?query=${keyword}`
    : 'https://www.zhipin.com/';
}

/**
 * 使用独立本地用户目录启动浏览器（彻底隔离主浏览器的 Cookie、密码与历史记录）
 */
export function openIsolatedBrowser(url = 'https://www.zhipin.com/') {
  ensureDataDirs();
  const exe = detectBrowserExecutable();
  if (!exe) {
    throw new Error('未在本机检测到 Chrome 或 Edge 浏览器，请确认已安装。');
  }

  const child = spawn(
    exe,
    [
      `--user-data-dir=${PATHS.browserProfileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      url,
    ],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
  child.unref();

  return {
    browser: exe,
    profileDir: PATHS.browserProfileDir,
    url,
  };
}

/**
 * 将 UTF-8 中文话术安全复制到 Windows 系统剪贴板（避免中文乱码）
 */
export function copyTextToClipboard(text) {
  const value = String(text ?? '');
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); $t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t',
    ],
    {
      input: Buffer.from(value, 'utf8'),
      windowsHide: true,
      timeout: 5000,
    }
  );
}

/**
 * 在 Windows 资源管理器中打开并选中指定文件（方便直接拖拽上传定制 PDF 简历）
 */
export function revealFileInExplorer(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('目标文件不存在，请先生成 PDF 简历。');
  }
  const child = spawn('explorer.exe', [`/select,${filePath}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
