import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PATHS, PUBLIC_DIR, ensureDataDirs } from './paths.mjs';
import {
  JOB_STATUSES,
  buildReviewStats,
  createJob,
  deleteCareerPlan,
  deleteCoachSession,
  deleteJob,
  getDb,
  getJobById,
  listAuditLogs,
  listJobs,
  updateJob,
  upsertInterviewPrep,
} from './db.mjs';
import {
  loadLocalConfig,
  loadMasterResume,
  loadPrivateProfile,
  maskApiKey,
  saveLocalConfig,
  saveMasterResume,
  savePrivateProfile,
} from './privacy.mjs';
import { exportCollabTask, importCollabTaskResult, runApiAnalysis } from './ai.mjs';
import {
  applyRoleTemplateToJob,
  buildQuickChatTemplates,
  buildSalaryStrategy,
  exportChatReplyCollab,
  exportInterviewPrepCollab,
  exportMockTurnCollab,
  getCoachBundle,
  importChatReplyCollab,
  importInterviewPrepCollab,
  importMockTurnCollab,
  runApiChatReply,
  runApiInterviewPrep,
  runApiMockTurn,
  startMockInterview,
} from './coach.mjs';
import {
  exportCareerPlanCollab,
  generateQuickCareerPlan,
  getCareerState,
  importCareerPlanCollab,
  patchCareerPlanProgress,
  runApiCareerPlan,
} from './career.mjs';
import { buildMobileOfflineHtml } from './mobile-export.mjs';
import { adoptRecommendedJobs, importDiscoveredJobsJson, searchAndRecommendJobs } from './job-finder.mjs';
import {
  exportResumeParseCollabTask,
  importResumeParseCollabResult,
  normalizeMasterResume,
  parseUploadedResume,
} from './resume-import.mjs';
import { generateJobResumePdf, renderResumeHtml } from './pdf.mjs';
import {
  copyTextToClipboard,
  detectBrowserExecutable,
  openIsolatedBrowser,
  resolveTargetUrl,
  revealFileInExplorer,
} from './browser.mjs';

const DEFAULT_PORT = Number(process.env.JOB_COPILOT_PORT || 3456);
const LOOPBACK_HOST = '127.0.0.1';

function detectLanIPv4List() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info && info.family === 'IPv4' && !info.internal) {
        ips.push(info.address);
      }
    }
  }
  return ips;
}

function isLoopbackRemote(req) {
  const addr = String(req.socket?.remoteAddress || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function parseCookies(req) {
  const header = String(req.headers?.cookie || '');
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function hashPinToken(pin) {
  return crypto.createHash('sha256').update(`job-copilot-pin:${pin}`).digest('hex').slice(0, 32);
}

function ensureLanPin(cfg) {
  if (cfg.allowLanAccess && (!cfg.accessPin || String(cfg.accessPin).trim().length < 4)) {
    const randomPin = String(crypto.randomInt(100000, 999999));
    return saveLocalConfig({ ...cfg, accessPin: randomPin });
  }
  return cfg;
}

function isLanAuthorized(req, cfg) {
  // 本机 127.0.0.1 访问免口令；非本机局域网访问必须开启 allowLanAccess 且校验 PIN
  if (isLoopbackRemote(req)) return true;
  if (!cfg.allowLanAccess || !cfg.accessPin) return false;
  const cookies = parseCookies(req);
  const headerPin = String(req.headers['x-access-pin'] || '').trim();
  const expectedToken = hashPinToken(cfg.accessPin);
  return cookies.jc_pin === expectedToken || headerPin === String(cfg.accessPin);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

async function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('上传内容过大（超过 10MB 限制），请压缩后重试。');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sanitizeConfigForClient(cfg) {
  return {
    ...cfg,
    apiKey: maskApiKey(cfg.apiKey),
    hasApiKey: Boolean(cfg.apiKey),
  };
}

export function createAppServer() {
  ensureDataDirs();
  getDb();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${LOOPBACK_HOST}`);
      const pathname = url.pathname;
      const method = req.method || 'GET';

      // PWA 清单（免鉴权，便于手机添加到主屏幕）
      if (method === 'GET' && pathname === '/manifest.webmanifest') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
        return res.end(
          JSON.stringify({
            name: '本地隐私求职助手',
            short_name: '求职助手',
            start_url: '/',
            display: 'standalone',
            background_color: '#f4f6fb',
            theme_color: '#0f172a',
            description: '隐私优先、双模式 AI 的本地求职、面试模拟与职业规划助手',
          })
        );
      }

      // 局域网访问口令校验接口
      if (method === 'POST' && pathname === '/api/auth/verify') {
        const body = await readJsonBody(req);
        const cfg = ensureLanPin(loadLocalConfig());
        if (isLoopbackRemote(req)) {
          return sendJson(res, 200, { ok: true, local: true });
        }
        if (!cfg.allowLanAccess || !cfg.accessPin) {
          return sendJson(res, 403, { error: '当前未开启局域网手机访问，请在电脑端「隐私与 AI 设置」开启并重启服务。' });
        }
        if (String(body.pin || '').trim() !== String(cfg.accessPin)) {
          return sendJson(res, 401, { error: '访问口令不正确，请核对电脑端控制台显示的 6 位口令。' });
        }
        const token = hashPinToken(cfg.accessPin);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `jc_pin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      // 静态首页（始终返回，由前端在未通过局域网鉴权时弹出 PIN 解锁层）
      if (method === 'GET' && pathname === '/') {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
        return sendHtml(res, 200, html);
      }

      // 所有 /api/* 业务接口对非本机局域网请求强制鉴权
      const currentCfg = ensureLanPin(loadLocalConfig());
      if (pathname.startsWith('/api/') && !isLanAuthorized(req, currentCfg)) {
        return sendJson(res, 401, { error: 'PIN_REQUIRED', message: '请输入电脑端显示的 6 位访问口令以解锁访问。' });
      }

      // 获取全局状态
      if (method === 'GET' && pathname === '/api/state') {
        const statusFilter = url.searchParams.get('status') || '';
        const lanIps = detectLanIPv4List();
        const listeningPort = req.socket?.localPort || DEFAULT_PORT;
        return sendJson(res, 200, {
          jobs: listJobs(statusFilter),
          statuses: JOB_STATUSES,
          review: buildReviewStats(),
          profile: loadPrivateProfile(),
          config: sanitizeConfigForClient(currentCfg),
          masterResume: loadMasterResume(),
          auditLogs: listAuditLogs(30),
          career: getCareerState(),
          system: {
            dataDir: PATHS.dataDir,
            browserDetected: Boolean(detectBrowserExecutable()),
            browserExe: detectBrowserExecutable(),
            lanIps,
            lanUrls: lanIps.map((ip) => `http://${ip}:${listeningPort}`),
            allowLanAccess: Boolean(currentCfg.allowLanAccess),
            isLocalClient: isLoopbackRemote(req),
          },
        });
      }

      // 复盘接口
      if (method === 'GET' && pathname === '/api/review') {
        return sendJson(res, 200, buildReviewStats());
      }

      // 根据主简历自动联网搜索并输出三档（练手训练 / 主力匹配 / 进阶挑战）精准岗位推荐
      if (method === 'POST' && pathname === '/api/jobs/recommend') {
        const body = await readJsonBody(req);
        const result = await searchAndRecommendJobs(body || {});
        return sendJson(res, 200, result);
      }

      // 模式 B：导入外部联网 AI 返回的岗位 JSON 数组并自动三档分类
      if (method === 'POST' && pathname === '/api/jobs/recommend/import') {
        const body = await readJsonBody(req);
        const result = importDiscoveredJobsJson(body?.resultText || '', body || {});
        return sendJson(res, 200, result);
      }

      // 一键采纳勾选的推荐岗位并直接生成定制简历与打招呼话术
      if (method === 'POST' && pathname === '/api/jobs/adopt') {
        const body = await readJsonBody(req);
        const candidates = Array.isArray(body.candidates) ? body.candidates : body.candidate ? [body.candidate] : [];
        const result = await adoptRecommendedJobs(candidates, {
          useApi: Boolean(body.useApi),
          generatePdf: body.generatePdf !== false,
        });
        return sendJson(res, 201, result);
      }

      // 新增岗位
      if (method === 'POST' && pathname === '/api/jobs') {
        const body = await readJsonBody(req);
        if (!body.company || !body.title || !body.jd_text) {
          return sendJson(res, 400, { error: '公司名称、岗位名称和岗位 JD 不能为空。' });
        }
        const job = createJob(body);
        return sendJson(res, 201, { job });
      }

      // 匹配 /api/jobs/:id 及子操作（支持二级子路径）
      const jobMatch = pathname.match(/^\/api\/jobs\/(\d+)(?:\/([a-z-]+(?:\/[a-z-]+)?))?$/);
      if (jobMatch) {
        const jobId = Number(jobMatch[1]);
        const action = jobMatch[2] || '';

        if (!action && method === 'GET') {
          const job = getJobById(jobId);
          return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: '岗位不存在' });
        }

        if (!action && method === 'PATCH') {
          const body = await readJsonBody(req);
          const updated = updateJob(jobId, body);
          return updated ? sendJson(res, 200, { job: updated }) : sendJson(res, 404, { error: '岗位不存在' });
        }

        if (!action && method === 'DELETE') {
          const ok = deleteJob(jobId);
          return ok ? sendJson(res, 200, { deleted: true }) : sendJson(res, 404, { error: '岗位不存在' });
        }

        // 双模式 AI 分析与定制
        if (action === 'analyze' && method === 'POST') {
          const body = await readJsonBody(req);
          const cfg = loadLocalConfig();
          const mode = body.mode || cfg.aiMode || 'collab';

          if (mode === 'api') {
            const result = await runApiAnalysis(jobId);
            let pdfInfo = null;
            try {
              pdfInfo = generateJobResumePdf(jobId);
            } catch (pdfErr) {
              pdfInfo = { error: pdfErr.message };
            }
            return sendJson(res, 200, {
              ...result,
              job: getJobById(jobId),
              pdf: pdfInfo,
            });
          }

          // 模式 B：零 API 协作模式
          const collab = exportCollabTask(jobId);
          return sendJson(res, 200, collab);
        }

        // 模式 B 导入结果并自动生成 PDF
        if (action === 'import-collab' && method === 'POST') {
          const body = await readJsonBody(req);
          const updated = importCollabTaskResult(jobId, body.resultText || null);
          let pdfInfo = null;
          try {
            pdfInfo = generateJobResumePdf(jobId);
          } catch (pdfErr) {
            pdfInfo = { error: pdfErr.message };
          }
          return sendJson(res, 200, {
            job: getJobById(jobId) || updated,
            pdf: pdfInfo,
          });
        }

        // 生成/刷新定制 PDF 简历
        if (action === 'render-pdf' && method === 'POST') {
          const pdfInfo = generateJobResumePdf(jobId);
          return sendJson(res, 200, pdfInfo);
        }

        // 浏览器直接预览简历 HTML
        if (action === 'preview-resume' && method === 'GET') {
          const job = getJobById(jobId);
          if (!job) return sendJson(res, 404, { error: '岗位不存在' });
          return sendHtml(res, 200, renderResumeHtml(job));
        }

        // 一键准备发送：保存选定话术 -> 写入剪贴板 -> 独立浏览器打开岗位页（由用户最终确认发送）
        if (action === 'prepare-send' && method === 'POST') {
          const body = await readJsonBody(req);
          let job = getJobById(jobId);
          if (!job) return sendJson(res, 404, { error: '岗位不存在' });

          const greetingText = String(body.greetingText ?? job.selected_greeting ?? '').trim();
          const greetingStyle = String(body.greetingStyle ?? job.greeting_style ?? '').trim();

          if (greetingText) {
            job = updateJob(jobId, {
              selected_greeting: greetingText,
              greeting_style: greetingStyle || job.greeting_style,
            });
            copyTextToClipboard(greetingText);
          }

          const targetUrl = resolveTargetUrl(job);
          const browserInfo = openIsolatedBrowser(targetUrl);

          return sendJson(res, 200, {
            job,
            copied: Boolean(greetingText),
            browserInfo,
            message: '打招呼话术已复制到剪贴板，并已在独立求职浏览器打开目标页面。核对后 Ctrl+V 粘贴并点击发送即可。',
          });
        }

        // 在资源管理器打开生成的 PDF 简历所在目录
        if (action === 'open-pdf-folder' && method === 'POST') {
          const job = getJobById(jobId);
          if (!job || !job.resume_pdf_path) {
            return sendJson(res, 400, { error: '该岗位尚未生成 PDF 简历，请先点击“生成 PDF”。' });
          }
          revealFileInExplorer(job.resume_pdf_path);
          return sendJson(res, 200, { opened: true, path: job.resume_pdf_path });
        }

        // 获取该岗位的面试预测、模拟面试、聊天记录、岗位模板、6维反问与谈薪策略
        if (action === 'coach' && method === 'GET') {
          const tplOverride = url.searchParams.get('templateId') || '';
          return sendJson(res, 200, getCoachBundle(jobId, tplOverride));
        }

        // 一键载入指定岗位类型的内置深度专业题库
        if (action === 'interview-prep/template' && method === 'POST') {
          const body = await readJsonBody(req);
          const prep = applyRoleTemplateToJob(jobId, body.templateId || '');
          return sendJson(res, 200, { prep, coach: getCoachBundle(jobId, body.templateId || '') });
        }

        // 面试预测题库生成（模式 A / 模式 B，支持人群阶段与岗位模板参数）
        if (action === 'interview-prep' && method === 'POST') {
          const body = await readJsonBody(req);
          const cfg = loadLocalConfig();
          const mode = body.mode || cfg.aiMode || 'collab';
          const opts = { careerStage: body.careerStage, templateId: body.templateId };
          if (mode === 'api') {
            return sendJson(res, 200, await runApiInterviewPrep(jobId, opts));
          }
          return sendJson(res, 200, exportInterviewPrepCollab(jobId, opts));
        }

        // 模式 B 导入面试预测题库结果
        if (action === 'interview-prep/import' && method === 'POST') {
          const body = await readJsonBody(req);
          const prep = importInterviewPrepCollab(jobId, body.resultText || null);
          return sendJson(res, 200, { prep });
        }

        // 保存练习勾选状态、微调题目或保存谈薪参数
        if (action === 'interview-prep' && method === 'PATCH') {
          const body = await readJsonBody(req);
          const prep = upsertInterviewPrep(jobId, body);
          const job = getJobById(jobId);
          return sendJson(res, 200, { prep, salary: buildSalaryStrategy(prep.salary_plan, job) });
        }

        // 开启一场新的 AI 模拟面试
        if (action === 'mock-interview/start' && method === 'POST') {
          const body = await readJsonBody(req);
          const session = startMockInterview(jobId, body.persona || '业务负责人/副总');
          return sendJson(res, 201, { session });
        }

        // HR 聊天与谈薪神回复（本地快捷模板 / 模式 A / 模式 B）
        if (action === 'chat-reply' && method === 'POST') {
          const body = await readJsonBody(req);
          const job = getJobById(jobId);
          if (!job) return sendJson(res, 404, { error: '岗位不存在' });
          const mode = body.mode || 'quick';
          if (mode === 'quick') {
            return sendJson(
              res,
              200,
              buildQuickChatTemplates(job, body.scenario || '自动识别', body.hrMessage || '', { useResume: true })
            );
          }
          if (mode === 'api') {
            return sendJson(res, 200, await runApiChatReply(jobId, body));
          }
          return sendJson(res, 200, exportChatReplyCollab(jobId, body));
        }

        // 模式 B 导入聊天/谈薪回复结果
        if (action === 'chat-reply/import' && method === 'POST') {
          const body = await readJsonBody(req);
          return sendJson(res, 200, importChatReplyCollab(jobId, body));
        }
      }

      // 模拟面试会话操作：/api/coach/sessions/:id/(turn|import)
      const sessionMatch = pathname.match(/^\/api\/coach\/sessions\/(\d+)(?:\/([a-z-]+))?$/);
      if (sessionMatch) {
        const sessionId = Number(sessionMatch[1]);
        const subAction = sessionMatch[2] || '';

        if (!subAction && method === 'DELETE') {
          const ok = deleteCoachSession(sessionId);
          return ok ? sendJson(res, 200, { deleted: true }) : sendJson(res, 404, { error: '会话不存在' });
        }
        if (subAction === 'turn' && method === 'POST') {
          const body = await readJsonBody(req);
          const cfg = loadLocalConfig();
          const mode = body.mode || cfg.aiMode || 'collab';
          if (mode === 'api') {
            return sendJson(res, 200, await runApiMockTurn(sessionId, body.answer));
          }
          return sendJson(res, 200, exportMockTurnCollab(sessionId, body.answer));
        }
        if (subAction === 'import' && method === 'POST') {
          const body = await readJsonBody(req);
          const session = importMockTurnCollab(sessionId, body.resultText || null);
          return sendJson(res, 200, { session });
        }
      }

      // 打开独立求职浏览器（用于平时逛 Boss 直聘/猎聘并保持隔离登录态）
      if (method === 'POST' && pathname === '/api/browser/open') {
        const body = await readJsonBody(req);
        const info = openIsolatedBrowser(body.url || 'https://www.zhipin.com/');
        return sendJson(res, 200, info);
      }

      // 保存隐私档案
      if (method === 'PUT' && pathname === '/api/settings/profile') {
        const body = await readJsonBody(req);
        const saved = savePrivateProfile(body);
        return sendJson(res, 200, { profile: saved });
      }

      // 导出纯手机独立离线单文件 HTML（支持 ?mode=generic 纯净通用版 或 ?mode=personal 个人离线版）
      if (method === 'GET' && pathname === '/api/export/mobile-html') {
        const mode = url.searchParams.get('mode') === 'personal' ? 'personal' : 'generic';
        const html = buildMobileOfflineHtml({ mode });
        const fileName = mode === 'personal' ? 'job-copilot-personal-mobile.html' : 'job-copilot-generic-mobile.html';
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Cache-Control': 'no-store',
        });
        return res.end(html);
      }

      // 职业规划与技能提升接口
      if (method === 'GET' && pathname === '/api/career') {
        return sendJson(res, 200, getCareerState());
      }
      if (method === 'POST' && pathname === '/api/career/generate') {
        const body = await readJsonBody(req);
        const mode = body.mode || 'quick';
        if (mode === 'quick') {
          const careerPlan = generateQuickCareerPlan(body);
          return sendJson(res, 201, { mode: 'quick', careerPlan, career: getCareerState() });
        }
        if (mode === 'api') {
          const result = await runApiCareerPlan(body);
          return sendJson(res, 201, { ...result, career: getCareerState() });
        }
        return sendJson(res, 200, exportCareerPlanCollab(body));
      }
      if (method === 'POST' && pathname === '/api/career/import') {
        const body = await readJsonBody(req);
        const careerPlan = importCareerPlanCollab(body.input || {}, body.resultText || null);
        return sendJson(res, 201, { careerPlan, career: getCareerState() });
      }
      const careerMatch = pathname.match(/^\/api\/career\/(\d+)$/);
      if (careerMatch) {
        const planId = Number(careerMatch[1]);
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          const updated = patchCareerPlanProgress(planId, body.plan);
          return sendJson(res, 200, { careerPlan: updated, career: getCareerState() });
        }
        if (method === 'DELETE') {
          const ok = deleteCareerPlan(planId);
          return ok ? sendJson(res, 200, { deleted: true, career: getCareerState() }) : sendJson(res, 404, { error: '规划不存在' });
        }
      }

      // 保存双模式 AI 配置（含局域网手机访问开关与 PIN 口令）
      if (method === 'PUT' && pathname === '/api/settings/config') {
        const body = await readJsonBody(req);
        let saved = saveLocalConfig(body);
        saved = ensureLanPin(saved);
        return sendJson(res, 200, { config: sanitizeConfigForClient(saved) });
      }

      // 预览当前主简历底稿（浏览器打开）
      if (method === 'GET' && pathname === '/api/settings/resume/preview') {
        return sendHtml(res, 200, renderResumeHtml(null));
      }

      // 本地离线解析上传简历（.docx / .txt / .md / .json）或粘贴全文
      if (method === 'POST' && pathname === '/api/settings/resume/parse') {
        const body = await readJsonBody(req);
        const parsed = parseUploadedResume(body);
        return sendJson(res, 200, parsed);
      }

      // 模式 B：导出脱敏主简历整理任务包
      if (method === 'POST' && pathname === '/api/settings/resume/collab-export') {
        const body = await readJsonBody(req);
        const collab = exportResumeParseCollabTask(body.rawText);
        return sendJson(res, 200, collab);
      }

      // 模式 B：导入整理好的主简历结果
      if (method === 'POST' && pathname === '/api/settings/resume/collab-import') {
        const body = await readJsonBody(req);
        const resume = importResumeParseCollabResult(body.resultText || null, { persist: true });
        return sendJson(res, 200, { masterResume: resume });
      }

      // 保存主简历底稿
      if (method === 'PUT' && pathname === '/api/settings/resume') {
        const body = await readJsonBody(req);
        const saved = saveMasterResume(normalizeMasterResume(body));
        return sendJson(res, 200, { masterResume: saved });
      }

      return sendJson(res, 404, { error: '接口不存在' });
    } catch (err) {
      return sendJson(res, 500, { error: err?.message || String(err) });
    }
  });
}

// 仅在直接运行此文件时启动监听
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const cfg = ensureLanPin(loadLocalConfig());
  const listenHost = cfg.allowLanAccess ? '0.0.0.0' : LOOPBACK_HOST;
  const server = createAppServer();
  server.listen(DEFAULT_PORT, listenHost, () => {
    console.log(`==================================================`);
    console.log(`本地隐私求职助手已启动`);
    console.log(`电脑访问地址: http://127.0.0.1:${DEFAULT_PORT}`);
    if (cfg.allowLanAccess) {
      const ips = detectLanIPv4List();
      console.log(`手机同Wi-Fi访问: ${ips.map((ip) => `http://${ip}:${DEFAULT_PORT}`).join(' 或 ') || '未检测到局域网IP'}`);
      console.log(`手机访问 6 位口令 (PIN): ${cfg.accessPin}`);
    } else {
      console.log(`访问范围: 仅限本机 127.0.0.1（如需手机同 Wi-Fi 访问，可在「隐私与 AI 设置」开启并重启）`);
    }
    console.log(`数据存储区: ${PATHS.dataDir}`);
    console.log(`==================================================`);
  });
}
