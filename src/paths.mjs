import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 程序根目录
export const PROGRAM_DIR = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(__dirname, 'public');

// 数据根目录（与源码完全隔离，防误提交）：优先环境变量；其次检测上级 data/job-copilot；否则落到同级 job-copilot-data
const legacyParentDataDir = path.resolve(PROGRAM_DIR, '..', '..', 'data', 'job-copilot');
const siblingDataDir = path.resolve(PROGRAM_DIR, '..', 'job-copilot-data');
export const DATA_DIR = process.env.JOB_COPILOT_DATA_DIR
  ? path.resolve(process.env.JOB_COPILOT_DATA_DIR)
  : fs.existsSync(legacyParentDataDir)
    ? legacyParentDataDir
    : siblingDataDir;

export const PATHS = {
  dataDir: DATA_DIR,
  privateDir: path.join(DATA_DIR, 'private'),
  resumesDir: path.join(DATA_DIR, 'resumes'),
  tasksDir: path.join(DATA_DIR, 'tasks'),
  browserProfileDir: path.join(DATA_DIR, 'browser-profile'),
  dbPath: path.join(DATA_DIR, 'jobs.db'),
  privateProfilePath: path.join(DATA_DIR, 'private', 'profile.private.json'),
  localConfigPath: path.join(DATA_DIR, 'private', 'config.local.json'),
  masterResumePath: path.join(DATA_DIR, 'resumes', 'master_resume.json'),
};

/**
 * 确保所有本地数据目录存在
 */
export function ensureDataDirs() {
  for (const dir of [
    PATHS.dataDir,
    PATHS.privateDir,
    PATHS.resumesDir,
    PATHS.tasksDir,
    PATHS.browserProfileDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
