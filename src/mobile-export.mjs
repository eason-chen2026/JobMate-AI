import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDataDirs } from './paths.mjs';
import { getInterviewPrep, listCareerPlans, listJobs } from './db.mjs';
import { loadMasterResume } from './privacy.mjs';
import {
  CAREER_STAGES,
  ROLE_TEMPLATES,
  UNIVERSAL_REVERSE_CHECKLIST,
  UNIVERSAL_SALARY_TRAPS,
  buildFullReverseChecklist,
  detectRoleTemplate,
  getFullQuestionsForTemplate,
} from './role-templates.mjs';
import { buildQuickChatTemplates, buildSalaryStrategy } from './coach.mjs';

function safeJsonForScript(obj) {
  return JSON.stringify(obj).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

// 纯内置 Lucide 风格线性 SVG 图标路径（零外部 CDN、零 Emoji）
const SVG_PATHS = {
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  message: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  sparkles: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  circle: '<circle cx="12" cy="12" r="10"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
};

function svgTag(name, size = 17) {
  const inner = SVG_PATHS[name] || '';
  return `<span class="ico"><svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg></span>`;
}

/**
 * 构建电脑/手机全端通用独立离线/联网增强单文件 HTML
 * - mode = 'generic'（纯净通用公开版）：零个人信息，13大行业每岗15~16题深度题库、显眼一级简历编辑入口、直达全网搜岗、自动生成适配简历与打印PDF
 * - mode = 'personal'（个人定制离线版）：预装个人脱敏岗位、专属题库与职业规划（不含手机/邮箱）
 */
export function buildMobileOfflineHtml({ mode = 'generic' } = {}) {
  const isPersonal = mode === 'personal';

  const jobs = isPersonal
    ? listJobs().map((j) => {
        const prep = getInterviewPrep(j.id);
        const tpl = prep.salary_plan?.templateId
          ? ROLE_TEMPLATES.find((t) => t.id === prep.salary_plan.templateId) || detectRoleTemplate(j.title, j.jd_text)
          : detectRoleTemplate(j.title, j.jd_text);
        const salary = buildSalaryStrategy(prep.salary_plan, j);
        return {
          id: j.id,
          platform: j.platform,
          company: j.company,
          title: j.title,
          city: j.city,
          salary: j.salary,
          url: j.url,
          tier: j.tier || '',
          jd_text: j.jd_text || '',
          match_score: j.match_score,
          match_summary: j.match_summary,
          risk_flags: j.risk_flags || [],
          greetings: j.greetings || [],
          tailored_resume: j.tailored_resume || null,
          templateId: tpl.id,
          prep: {
            questions: prep.questions || [],
            reverse_questions: prep.reverse_questions || [],
            salary_plan: salary.plan,
          },
        };
      })
    : [];

  const chatScenarios = [
    '核实双休与福利',
    '薪资试探与报价',
    '应对压薪或试用期打折',
    '回应空窗期或离职原因',
    '回应学历或跨类目追问',
    '推进约面或体面婉拒',
  ];

  const quickChatBank = Object.fromEntries(
    chatScenarios.map((sc) => [
      sc,
      buildQuickChatTemplates({ company: '贵司', title: '目标岗位', salary: '目标区间' }, sc).replies,
    ])
  );

  const enrichedRoleTemplates = ROLE_TEMPLATES.map((t) => ({
    ...t,
    questions: getFullQuestionsForTemplate(t.id),
  }));

  const payload = {
    mode: isPersonal ? 'personal' : 'generic',
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    jobs,
    masterResume: isPersonal ? loadMasterResume() : null,
    careerPlans: isPersonal ? listCareerPlans(10) : [],
    roleTemplates: enrichedRoleTemplates,
    careerStages: CAREER_STAGES,
    universalReverseChecklist: UNIVERSAL_REVERSE_CHECKLIST,
    universalSalaryTraps: UNIVERSAL_SALARY_TRAPS,
    quickChatBank,
    reverseChecklistsByTemplate: Object.fromEntries(
      ROLE_TEMPLATES.map((t) => [t.id, buildFullReverseChecklist(t.id)])
    ),
  };

  const titleText = isPersonal ? '职伴 AI · 个人离线版' : '职伴 AI (JobMate-AI) · 全行业求职助手';
  const badgeText = isPersonal ? '个人离线同步版' : '电脑/手机通用 · 零隐私上云';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="theme-color" content="#0f172a" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="职伴AI" />
${!isPersonal ? '<link rel="manifest" href="./manifest.webmanifest" />' : ''}
<title>${titleText}</title>
<style>
  :root { --bg:#f4f6fb; --card:#ffffff; --line:#e2e8f0; --text:#0f172a; --muted:#475569; --primary:#2563eb; --primary-hover:#1d4ed8; --green:#059669; --amber:#d97706; --red:#dc2626; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; padding-bottom:88px; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; font-size:16px; line-height:1.65; }
  .ico { display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; vertical-align:-3px; }
  .ico svg { display:block; }
  .brand-logo { width:30px; height:30px; border-radius:9px; background:linear-gradient(135deg,#2563eb,#0ea5e9); display:inline-flex; align-items:center; justify-content:center; color:#fff; flex-shrink:0; }
  .header { position:sticky; top:0; z-index:20; background:#0f172a; color:#fff; padding:12px 14px; box-shadow:0 2px 10px rgba(15,23,42,0.18); }
  .header-inner { max-width:1200px; margin:0 auto; display:flex; flex-direction:column; gap:8px; }
  .header h1 { margin:0; font-size:17px; font-weight:800; display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .brand-left { display:flex; align-items:center; gap:9px; }
  .badge { font-size:12px; background:rgba(16,185,129,0.2); color:#6ee7b7; border:1px solid rgba(16,185,129,0.4); padding:3px 9px; border-radius:999px; font-weight:600; white-space:nowrap; }
  .sub { font-size:12.5px; color:#cbd5e1; margin-top:3px; }
  .desktop-nav { display:none; gap:8px; flex-wrap:wrap; }
  .dnav-btn { border:1px solid rgba(255,255,255,0.2); background:transparent; color:#e2e8f0; padding:8px 14px; border-radius:9px; font-size:14px; font-weight:600; cursor:pointer; min-height:38px; display:inline-flex; align-items:center; gap:6px; }
  .dnav-btn:hover { background:rgba(255,255,255,0.1); color:#fff; }
  .dnav-btn.active { background:var(--primary); border-color:var(--primary); color:#fff; font-weight:700; }
  .wrap { max-width:820px; margin:0 auto; padding:14px; }
  .desktop-2col { display:block; }
  .panel { display:none; }
  .panel.active { display:block; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; box-shadow:0 1px 3px rgba(15,23,42,0.04); }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .between { justify-content:space-between; }
  h2 { margin:0 0 10px; font-size:17.5px; font-weight:800; color:#0f172a; display:flex; align-items:center; gap:8px; line-height:1.4; }
  h3 { margin:0 0 8px; font-size:15.5px; font-weight:700; color:#1e3a8a; display:flex; align-items:center; gap:7px; line-height:1.4; }
  .muted { color:var(--muted); font-size:13.5px; line-height:1.55; }
  .pill { display:inline-flex; align-items:center; gap:5px; padding:3px 10px; border-radius:999px; font-size:12.5px; font-weight:700; background:#e2e8f0; color:#334155; }
  .pill.green { background:#dcfce7; color:#166534; }
  .pill.blue { background:#dbeafe; color:#1e40af; }
  .pill.red { background:#fee2e2; color:#991b1b; }
  button, a.link-btn, label.file-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; text-decoration:none; border:1px solid #cbd5e1; background:#fff; color:var(--text); padding:9px 14px; border-radius:10px; font-size:14.5px; font-weight:600; cursor:pointer; min-height:42px; transition:background 0.12s, border-color 0.12s; }
  button:hover, a.link-btn:hover, label.file-btn:hover { background:#f8fafc; }
  button.primary, a.link-btn.primary { background:var(--primary); color:#fff; border-color:var(--primary); font-weight:700; }
  button.primary:hover, a.link-btn.primary:hover { background:var(--primary-hover); }
  button.success { background:var(--green); color:#fff; border-color:var(--green); font-weight:700; }
  button.danger { color:var(--red); border-color:#fecaca; }
  button.sm-btn { padding:6px 11px; min-height:34px; font-size:13px; }
  select, input, textarea { width:100%; padding:11px 12px; border:1px solid #cbd5e1; border-radius:10px; font-size:15.5px; font-family:inherit; background:#fff; color:var(--text); line-height:1.5; }
  select:focus, input:focus, textarea:focus { outline:none; border-color:var(--primary); box-shadow:0 0 0 3px rgba(37,99,235,0.12); }
  .field { margin-bottom:12px; }
  .field label { display:block; font-size:13.5px; font-weight:700; color:#1e293b; margin-bottom:5px; }
  .box { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px 13px; margin-top:10px; white-space:pre-wrap; font-size:15px; line-height:1.68; }
  .qa-done { border-color:#86efac; background:#f0fdf4; }
  .seg-bar { display:grid; grid-template-columns:1fr 1fr; gap:8px; background:#e2e8f0; padding:5px; border-radius:13px; margin-bottom:14px; }
  .seg-btn { border:none; background:transparent; color:#334155; font-size:15px; font-weight:700; padding:10px 8px; border-radius:10px; min-height:44px; display:flex; align-items:center; justify-content:center; gap:7px; }
  .seg-btn.active { background:#ffffff; color:#1d4ed8; box-shadow:0 2px 6px rgba(15,23,42,0.1); }
  .resume-banner { background:linear-gradient(135deg,#eff6ff,#f0f9ff); border:1.5px solid #93c5fd; border-radius:14px; padding:14px 15px; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  .exp-card { border:1px solid #cbd5e1; background:#f8fafc; border-radius:12px; padding:13px; margin-bottom:12px; }
  .chip-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .chip { border:1px solid #cbd5e1; background:#fff; color:#334155; padding:6px 12px; border-radius:999px; font-size:13px; font-weight:600; min-height:34px; }
  .chip.active { background:#1e3a8a; color:#fff; border-color:#1e3a8a; }
  .bottom-nav { position:fixed; bottom:0; left:0; right:0; z-index:30; background:#fff; border-top:1px solid var(--line); display:grid; grid-template-columns:repeat(5,1fr); padding-bottom:env(safe-area-inset-bottom); box-shadow:0 -2px 10px rgba(15,23,42,0.06); }
  .nav-btn { border:none; border-radius:0; background:transparent; padding:8px 4px; font-size:12px; font-weight:600; color:#475569; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; min-height:60px; }
  .nav-btn.active { color:var(--primary); font-weight:800; background:#eff6ff; }
  .kpi-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:12px 0; }
  .kpi { background:#f8fbff; border:1px solid #bfdbfe; border-radius:10px; padding:12px; }
  .kpi .v { font-size:21px; font-weight:800; color:#1d4ed8; margin:2px 0; }
  .modal-mask { position:fixed; inset:0; background:rgba(15,23,42,0.55); display:none; align-items:center; justify-content:center; z-index:60; padding:12px; }
  .modal-mask.open { display:flex; }
  .modal { background:#fff; border-radius:14px; width:100%; max-width:760px; max-height:92vh; overflow-y:auto; padding:18px; }
  .toast { position:fixed; left:50%; bottom:80px; transform:translateX(-50%); background:#0f172a; color:#fff; padding:10px 18px; border-radius:999px; font-size:14px; font-weight:600; display:none; z-index:99; max-width:92%; text-align:center; box-shadow:0 6px 20px rgba(15,23,42,0.28); }
  details summary { cursor:pointer; font-weight:700; list-style:none; }
  details summary::-webkit-details-marker { display:none; }
  .sum-link { color:#2563eb; font-size:14.5px; font-weight:700; display:inline-flex; align-items:center; gap:6px; padding:4px 0; }
  @media (min-width: 960px) {
    body { padding-bottom:28px; font-size:15px; }
    .header { padding:12px 24px; }
    .header-inner { flex-direction:row; justify-content:space-between; align-items:center; }
    .header h1 { justify-content:flex-start; }
    .desktop-nav { display:flex; }
    .bottom-nav { display:none; }
    .wrap { max-width:1220px; padding:20px 24px; }
    .desktop-2col { display:grid; grid-template-columns:1fr 1fr; gap:18px; align-items:start; }
    .desktop-2col.wide-left { grid-template-columns:1.3fr 0.9fr; }
    .toast { bottom:24px; }
  }
  @media print {
    .header, #wx-banner, .wrap, .bottom-nav, .no-print, .toast { display:none !important; }
    .modal-mask { position:static; display:block !important; background:#fff; padding:0; }
    .modal { max-width:100%; max-height:none; overflow:visible; box-shadow:none; padding:0; }
    body { padding:0; background:#fff; font-size:13.5px; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-inner">
      <div>
        <h1>
          <span class="brand-left">
            <span class="brand-logo">${svgTag('briefcase', 17)}</span>
            <span>${titleText}</span>
          </span>
          <span class="badge">${badgeText}</span>
        </h1>
        <div class="sub">13 大全行业每岗 15+ 深度题库 · 一级简历底稿管理 · 直达搜岗与适配简历 · 数据仅存本机浏览器</div>
      </div>
      <div class="desktop-nav">
        <button class="dnav-btn active" data-p="jobs" onclick="goTab('jobs')">${svgTag('briefcase', 16)}<span>搜岗与简历</span></button>
        <button class="dnav-btn" data-p="prep" onclick="goTab('prep')">${svgTag('target', 16)}<span>面试题库</span></button>
        <button class="dnav-btn" data-p="career" onclick="goTab('career')">${svgTag('compass', 16)}<span>职业规划</span></button>
        <button class="dnav-btn" data-p="chat" onclick="goTab('chat')">${svgTag('message', 16)}<span>聊天神回复</span></button>
        <button class="dnav-btn" data-p="salary" onclick="goTab('salary')">${svgTag('wallet', 16)}<span>谈薪与设置</span></button>
      </div>
    </div>
  </div>
  <div id="wx-banner" style="display:none; background:#fffbeb; border-bottom:1px solid #fde68a; color:#92400e; padding:10px 14px; font-size:13.5px; font-weight:600;">
    <div style="max-width:820px; margin:0 auto; display:flex; justify-content:space-between; align-items:center; gap:10px;">
      <span>微信内可直接正常使用；如需添加到手机桌面当 App 或打印 PDF，请点右上角「···」选「在浏览器打开」。</span>
      <button class="sm-btn" onclick="document.getElementById('wx-banner').style.display='none'">知道了</button>
    </div>
  </div>

  <div class="wrap">
    <!-- 1. 搜岗、岗位池与一级显眼简历底稿 -->
    <div id="p-jobs" class="panel active">
      <div class="seg-bar" role="tablist">
        <button id="seg-btn-search" class="seg-btn active" onclick="switchJobsSubView('search')">${svgTag('search', 18)}<span>搜岗与岗位池</span></button>
        <button id="seg-btn-resume" class="seg-btn" onclick="switchJobsSubView('resume')">${svgTag('fileText', 18)}<span>我的简历底稿</span><span id="resume-status-pill" class="pill" style="font-size:11.5px; padding:1px 7px;">未填</span></button>
      </div>

      <!-- 子视图 A：搜岗与岗位池 -->
      <div id="sub-jobs-search">
        <div id="resume-guide-banner" class="resume-banner">
          <div style="flex:1; min-width:220px;">
            <strong style="color:#1e3a8a; font-size:15.5px; display:flex; align-items:center; gap:6px;">${svgTag('fileText', 17)}<span>先填一次「我的简历底稿」，即可对任意岗位一键生成适配简历与 PDF</span></strong>
            <div class="muted" style="margin-top:3px;">支持直接上传 .pdf / .docx / .txt / .md / .json 简历一键解析填入，也支持手动分段维护，数据 100% 仅存本机。</div>
          </div>
          <button class="primary" onclick="switchJobsSubView('resume')">${svgTag('plus', 16)}<span>去填写 / 导入简历</span></button>
        </div>

        <div class="desktop-2col">
          <div>
            <!-- 快捷联网搜岗直达与三档推荐 -->
            <div class="card" style="background:#f8fbff; border-color:#bfdbfe;">
              <h2>${svgTag('search', 19)}<span>智能三档荐岗 & 一键全网搜岗</span></h2>
              <div class="row">
                <div class="field" style="flex:1; min-width:105px;"><label>目标城市</label><input id="s-city" value="上海" placeholder="如：北京 / 上海 / 深圳" oninput="updateSearchLinks()" /></div>
                <div class="field" style="flex:2; min-width:155px;"><label>想找的岗位关键词（留空读简历）</label><input id="s-kw" placeholder="如：AI产品经理 / Java / 会计 / 主播" oninput="updateSearchLinks()" /></div>
                <div class="field" style="flex:1; min-width:95px;"><label>期望月薪(K)</label><input id="s-sal" type="number" value="18" min="3" max="200" /></div>
              </div>
              <div id="s-match-hint" class="muted" style="margin-bottom:10px;">输入任意岗位，自动匹配 13 大行业 15+ 题库与薪资百科，并支持按「练手训练 / 主力匹配 / 进阶挑战」三档推荐。</div>
              <div class="row" style="margin-bottom:10px;">
                <button class="primary" style="flex:1;" id="btn-m-rec" onclick="runMobileTierRecommend(false)">${svgTag('sparkles', 16)}<span>根据简历生成三档推荐</span></button>
                <button class="success" style="flex:1;" id="btn-m-rec-more" onclick="runMobileTierRecommend(true)">${svgTag('plus', 16)}<span>+ 换一批 / 加更多岗位</span></button>
              </div>
              <div id="s-links" class="row"></div>
              <details id="m-collab-rec-box" style="margin-top:10px; border:1px dashed #93c5fd; border-radius:10px; padding:10px 12px; background:#fff;">
                <summary class="sum-link" style="color:#1e3a8a;">${svgTag('upload', 15)}<span>零 Key 联网批量导入真实岗位（模式 B · 支持持续追加）</span></summary>
                <div class="muted" style="margin-top:6px;">复制脱敏指令发给任意联网 AI 助手，把返回的企业岗位 JSON 贴进来，即可按三档自动分类并支持多次追加。</div>
                <div class="row" style="margin-top:8px;">
                  <button class="sm-btn" onclick="copyMobileCollabRecPrompt()">复制脱敏联网搜岗指令</button>
                  <button class="sm-btn primary" onclick="importMobileCollabRecJson(false)">导入并覆盖</button>
                  <button class="sm-btn success" onclick="importMobileCollabRecJson(true)">追加到当前三档</button>
                </div>
                <textarea id="m-collab-rec-json" rows="3" style="margin-top:8px;" placeholder="将联网 AI 返回的岗位 JSON 数组粘贴到这里，点击「导入并覆盖」或「追加到当前三档」"></textarea>
              </details>
              <div id="m-rec-results" style="margin-top:12px;"></div>
            </div>

            <!-- 新增岗位与智能匹配 -->
            <div class="card">
              <div class="row between">
                <div>
                  <h2 style="margin-bottom:3px;">${svgTag('plus', 19)}<span>新增目标岗位（智能匹配行业）</span></h2>
                  <div class="muted">自动匹配 15+ 题行业题库，支持一键生成打招呼话术与本岗适配简历。</div>
                </div>
                <button class="primary" onclick="toggleAddJob()">展开 / 收起</button>
              </div>
              <div id="add-job-box" style="display:none; margin-top:12px; border-top:1px dashed #cbd5e1; padding-top:12px;">
                <div class="row">
                  <div class="field" style="flex:1; min-width:140px;"><label>公司名称 *</label><input id="mj-company" placeholder="如：某某科技" /></div>
                  <div class="field" style="flex:1; min-width:140px;"><label>岗位名称 *</label><input id="mj-title" placeholder="输入后自动匹配行业模板" oninput="onNewJobInput()" /></div>
                </div>
                <div class="row">
                  <div class="field" style="flex:1; min-width:140px;"><label>薪资范围</label><input id="mj-salary" placeholder="如：15-25K" /></div>
                  <div class="field" style="flex:1; min-width:140px;"><label>城市 / 作息</label><input id="mj-city" placeholder="如：上海 · 双休" /></div>
                </div>
                <div class="field">
                  <label>智能匹配的行业模板（已自动推荐，也可手动切换）</label>
                  <select id="mj-tpl"></select>
                </div>
                <div class="field"><label>岗位 JD 原文或核心要求（粘贴后可自动提取关键词生成适配简历）</label><textarea id="mj-jd" rows="3" placeholder="从 Boss直聘/猎聘 复制粘贴岗位职责与要求（选填）" oninput="onNewJobInput()"></textarea></div>
                <div class="field"><label>岗位链接（选填）</label><input id="mj-url" placeholder="https://..." /></div>
                <div class="field">
                  <div class="row between" style="margin-bottom:6px;">
                    <label style="margin:0;">打招呼话术（可点右侧按钮自动生成）</label>
                    <button class="sm-btn" onclick="autoFillJobGreeting()">${svgTag('sparkles', 15)}<span>自动生成适配话术</span></button>
                  </div>
                  <textarea id="mj-greet" rows="3" placeholder="点击上方「自动生成适配话术」或自行填写"></textarea>
                </div>
                <button class="success" style="width:100%;" onclick="addMobileJob()">${svgTag('check', 17)}<span>保存到岗位池（并关联推荐题库）</span></button>
              </div>
            </div>
          </div>
          <div>
            <div id="jobs-list"></div>
          </div>
        </div>
      </div>

      <!-- 子视图 B：独立显眼的「我的简历底稿」编辑器 -->
      <div id="sub-jobs-resume" style="display:none;">
        <div class="card">
          <div class="row between" style="margin-bottom:10px;">
            <div>
              <h2 style="margin-bottom:3px;">${svgTag('fileText', 19)}<span>我的简历底稿（仅保存在本机浏览器）</span></h2>
              <div class="muted">填写保存后，去岗位池点任意岗位的「生成适配简历」即可按 JD 关键词自动重排并打印 A4 PDF。</div>
            </div>
            <label class="file-btn">
              ${svgTag('upload', 16)}<span>上传简历 (.pdf / .docx / .txt)</span>
              <input type="file" accept=".pdf,.docx,.txt,.md,.json" style="display:none;" onchange="importResumeTextFile(event)" />
            </label>
          </div>
          <div id="mr-import-tip" class="muted" style="margin-bottom:10px;">纯浏览器本地解析 PDF / Word 简历，文件绝不上传任何服务器；解析后请快速核对并点底部「保存」。</div>

          <div class="row">
            <div class="field" style="flex:1; min-width:150px;"><label>称呼 / 姓名（仅本地存 PDF）</label><input id="mr-name" placeholder="如：张同学 / 你的姓名" /></div>
            <div class="field" style="flex:1; min-width:150px;"><label>联系方式（选填）</label><input id="mr-contact" placeholder="手机 / 邮箱 / 意向城市" /></div>
          </div>
          <div class="row">
            <div class="field" style="flex:1; min-width:150px;"><label>当前定位 / 学历与工作年限</label><input id="mr-basic" placeholder="如：本科 · 3年经验 / 2026届应届生" /></div>
            <div class="field" style="flex:1; min-width:150px;">
              <label>求职阶段</label>
              <select id="mr-stage">
                <option value="fresh_grad">应届生 / 大学生</option>
                <option value="mid_career" selected>社招 1-5 年</option>
                <option value="senior_lead">资深骨干 / 管理者</option>
              </select>
            </div>
          </div>
          <div class="field"><label>个人核心优势与量化代表成果（每行一条）</label><textarea id="mr-summary" rows="4" placeholder="每行写一条你最亮眼的经历或数据结果，用于生成适配简历与打招呼话术"></textarea></div>
          <div class="field"><label>已掌握核心技能（每行或逗号分隔）</label><textarea id="mr-skills" rows="3" placeholder="如：Python, SQL, AI提示词, 项目管理, 数据分析, 直播运营"></textarea></div>

          <div class="field">
            <div class="row between" style="margin-bottom:8px;">
              <label style="margin:0;">工作 / 实习 / 核心项目经历（支持添加多段）</label>
              <button class="sm-btn primary" onclick="addMobileExpItem()">${svgTag('plus', 15)}<span>新增一段经历</span></button>
            </div>
            <div id="mr-exp-cards"></div>
          </div>

          <div class="field"><label>教育背景（选填）</label><input id="mr-edu" placeholder="如：某某大学 · 本科 · 专业 · 2020.09 - 2024.06" /></div>

          <div class="row" style="margin-top:14px;">
            <button class="primary" style="flex:1;" onclick="saveMobileResume()">${svgTag('check', 17)}<span>保存我的简历底稿</span></button>
            <button style="flex:1;" onclick="previewMasterMobileResume()">${svgTag('printer', 17)}<span>预览 / 打印简历 PDF</span></button>
          </div>
        </div>
      </div>
    </div>

    <!-- 2. 深度面试题库与6维反问 -->
    <div id="p-prep" class="panel">
      <div class="desktop-2col wide-left">
        <div>
          <div class="card">
            <h2>${svgTag('target', 19)}<span>全行业深度面试题库（每岗 15~16 题）</span></h2>
            <div class="field" id="m-prep-job-wrap" style="display:none;">
              <label>选择我的岗位（自动联动匹配该岗行业模板）</label>
              <select id="m-prep-job" onchange="onPrepJobChange()"></select>
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>行业岗位模板（5 大行业分组 · 13 大全行业，每岗内置 15+ 深度题）</label>
              <select id="m-prep-tpl" onchange="onPrepTemplateChange()"></select>
            </div>
            <div id="m-prep-cat-chips" class="chip-row"></div>
            <div class="row between" style="margin-top:12px;">
              <strong id="m-prep-title" style="font-size:15.5px;">深度预测题库</strong>
              <button class="sm-btn" onclick="toggleAddQ()">${svgTag('plus', 15)}<span>手动加题</span></button>
            </div>
            <div id="add-q-box" style="display:none; margin-top:12px; border-top:1px dashed #cbd5e1; padding-top:12px;">
              <div class="field"><label>题目分类</label><select id="mq-cat"><option>核心业务深挖</option><option>实操情景推演</option><option>团队与跨部门管理</option><option>短板与敏感追问</option><option>动机与薪资稳定性</option></select></div>
              <div class="field"><label>面试问题 *</label><input id="mq-q" placeholder="写下你想重点练习的面试问题" /></div>
              <div class="field"><label>答题框架（选填）</label><input id="mq-fw" placeholder="1. ... 2. ... 3. ..." /></div>
              <div class="field"><label>参考答案 *</label><textarea id="mq-ans" rows="3" placeholder="写下你的口语化高分答法"></textarea></div>
              <button class="primary" style="width:100%;" onclick="addMobileQuestion()">${svgTag('check', 16)}<span>保存到本机题库</span></button>
            </div>
          </div>
          <div id="m-prep-questions"></div>
        </div>
        <div>
          <div class="card">
            <h3>${svgTag('shield', 18)}<span>面试者反向考察清单（6大维度 · 随岗位切换）</span></h3>
            <div class="muted" style="margin-bottom:8px;">工作职责、业务现状、团队配置、薪资口径、双休保障 + 本行业专属必问项。</div>
            <div id="m-reverse-checklist"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. 职业规划与技能练习 -->
    <div id="p-career" class="panel">
      <div class="card">
        <h2>${svgTag('compass', 19)}<span>职业规划 & 技能提升生成器</span></h2>
        <div class="muted" style="margin-bottom:10px;">不知道找什么岗位可做多路线定位；已有目标岗位可测技能缺口、练法并一键直达推荐岗位搜岗与刷题。</div>
        <div class="field">
          <label>规划场景</label>
          <select id="mc-type">
            <option value="explore">不确定找什么岗位 → 多路线职业方向定位与推荐岗位</option>
            <option value="skill_upgrade">已有目标岗位 → 技能缺口诊断与练习清单</option>
          </select>
        </div>
        <div class="field">
          <label>你当前所处的阶段</label>
          <select id="mc-stage">
            <option value="fresh_grad">应届生 / 刚出校门大学生</option>
            <option value="mid_career" selected>社招职场人（1-5年实战/晋升）</option>
            <option value="senior_lead">资深骨干 / 团队负责人 / 跨界转型</option>
          </select>
        </div>
        <div class="field">
          <label>目标岗位或感兴趣方向（任意岗位，如 AI产品 / Java / 会计 / HR / 设计 / 主播）</label>
          <input id="mc-role" placeholder="留空则按你所填技能与阶段做全方向探索" />
        </div>
        <div class="field">
          <label>目前已掌握的核心技能 / 专业背景（逗号分隔）</label>
          <input id="mc-skills" placeholder="如：Python, SQL, 平面设计, 财务核算, 客户沟通, 剪辑" />
        </div>
        <button class="primary" style="width:100%;" onclick="generateMobileCareerPlan()">${svgTag('sparkles', 17)}<span>0 秒智能匹配推荐岗位与技能练习方案</span></button>
      </div>
      <div id="m-career-body"></div>
    </div>

    <!-- 4. HR 聊天智能回复（结合简历底稿 · 电脑/手机通用） -->
    <div id="p-chat" class="panel">
      <div class="card">
        <h2>${svgTag('message', 19)}<span>HR 消息智能回复（结合我的简历底稿 · 秒复制）</span></h2>
        <div class="muted" style="margin-bottom:10px;">直接粘贴 Boss直聘 / 猎聘 上 HR 发来的消息，系统会自动识别意图并结合你填好的「我的简历底稿」与目标岗位生成 3 套回复。</div>
        <div class="row">
          <div class="field" style="flex:1; min-width:160px;">
            <label>关联目标岗位（选填，让回复贴合该岗位）</label>
            <select id="m-chat-job" onchange="onMobileChatContextChange()">
              <option value="">不绑定具体岗位（通用回复）</option>
            </select>
          </div>
          <div class="field" style="flex:1; min-width:160px;">
            <label>沟通场景（推荐自动识别 HR 意图）</label>
            <select id="m-chat-scene" onchange="onMobileChatContextChange()"></select>
          </div>
        </div>
        <div class="field">
          <label>粘贴 HR / 用人单位发来的原话（留空也可按下方场景直接出模板）</label>
          <textarea id="m-chat-hr-msg" rows="3" placeholder="例如：我们底薪15K绩效5K，偶尔大小周能接受吗？方便的话发份简历看看？"></textarea>
        </div>
        <div class="row">
          <button class="primary" style="flex:1; min-width:170px;" onclick="generateMobileSmartChatReply(false)">${svgTag('sparkles', 16)}<span>结合简历 0 秒生成 3 套回复</span></button>
          <button class="success" style="flex:1; min-width:155px;" id="btn-m-chat-ai" onclick="generateMobileSmartChatReply(true)">${svgTag('zap', 16)}<span>用已配 AI 深度定制</span></button>
          <button class="sm-btn" onclick="copyMobileChatCollabPrompt()">${svgTag('copy', 15)}<span>复制脱敏指令给外部 AI</span></button>
        </div>
        <div id="m-chat-analysis" class="box" style="display:none; background:#eff6ff; border-color:#bfdbfe; color:#1e3a8a;"></div>
      </div>
      <div id="m-chat-replies"></div>
    </div>

    <!-- 5. 谈薪博弈、AI 联网设置与备份 -->
    <div id="p-salary" class="panel">
      <div class="desktop-2col">
        <div>
          <div class="card">
            <h2>${svgTag('wallet', 19)}<span>谈薪博弈计算器 & 13 大行业薪资百科</span></h2>
            <div class="row">
              <div class="field" style="flex:1;"><label>目标月薪(K)</label><input id="ms-target" type="number" value="15" oninput="calcSalary()" /></div>
              <div class="field" style="flex:1;"><label>心理底线(K)</label><input id="ms-floor" type="number" value="12" oninput="calcSalary()" /></div>
            </div>
            <div class="row">
              <div class="field" style="flex:1;"><label>年薪月数</label><input id="ms-months" type="number" value="13" oninput="calcSalary()" /></div>
              <div class="field" style="flex:1;"><label>绩效占比(%)</label><input id="ms-perf" type="number" value="20" oninput="calcSalary()" /></div>
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>切换行业查看典型薪资结构与防坑核验点</label>
              <select id="ms-tpl" onchange="calcSalary()"></select>
            </div>
            <div id="ms-kpis" class="kpi-grid"></div>
            <div id="ms-role-tip" class="box" style="background:#eff6ff; border-color:#bfdbfe; color:#1e3a8a;"></div>
          </div>
          <details class="card">
            <summary class="sum-link" style="color:#1e3a8a;">${svgTag('settings', 17)}<span>浏览器直连官方 AI 设置（选填：填 Key 可联网深度改简历）</span></summary>
            <div style="margin-top:12px;">
              <div class="muted" style="margin-bottom:10px;">不填也能 100% 离线使用全部功能；若填入自己的 DeepSeek / Gemini 官方 Key（仅保存在本机浏览器），可直接联网按 JD 深度改写定制简历与话术。</div>
              <div class="field">
                <label>官方 API 服务商</label>
                <select id="ma-provider">
                  <option value="deepseek">DeepSeek 官方 (deepseek-chat · 中文性价比高)</option>
                  <option value="gemini">Google Gemini 官方 (gemini-2.5-flash)</option>
                </select>
              </div>
              <div class="field"><label>官方 API Key（仅存本机浏览器）</label><input id="ma-key" type="password" placeholder="粘贴你的官方 API Key（可留空）" /></div>
              <button class="primary" onclick="saveMobileApi()">${svgTag('check', 16)}<span>保存 AI 设置</span></button>
            </div>
          </details>
          <div class="card">
            <h3>${svgTag('download', 17)}<span>跨设备数据备份与恢复（电脑 ↔ 手机互导）</span></h3>
            <div class="muted" style="margin-bottom:10px;">所有记录仅保存在当前浏览器本地；如需在电脑和手机间同步，可导出 JSON 文件后在另一台设备导入。</div>
            <div class="row">
              <button class="primary" onclick="downloadLocalBackupFile()">${svgTag('download', 16)}<span>下载备份 (.json)</span></button>
              <label class="file-btn">${svgTag('upload', 16)}<span>导入恢复 (.json)</span><input type="file" accept=".json" style="display:none;" onchange="importLocalBackupFile(event)" /></label>
              <button class="danger" onclick="clearLocalData()">${svgTag('trash', 16)}<span>清空本机记录</span></button>
            </div>
          </div>
        </div>
        <div>
          <div class="card">
            <h3>${svgTag('zap', 17)}<span>6 大压薪场景见招拆招话术（随数字实时联动）</span></h3>
            <div id="ms-playbooks"></div>
          </div>
          <div class="card" style="background:#fef2f2; border-color:#fecaca;">
            <h3 style="color:#991b1b;">${svgTag('alert', 17)}<span>全岗位通用 6 大薪资与签约防坑红线</span></h3>
            <ul id="ms-traps" style="margin:8px 0 0 20px; padding:0; color:#7f1d1d; font-size:14.5px; line-height:1.65;"></ul>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 适配简历预览与打印弹窗 -->
  <div id="resume-modal" class="modal-mask">
    <div class="modal">
      <div class="row between no-print" style="margin-bottom:12px;">
        <strong id="rm-modal-title" style="font-size:16px;">岗位适配简历预览</strong>
        <div class="row">
          <button class="primary" onclick="printTailoredResume()">${svgTag('printer', 16)}<span>打印 / 存为 PDF</span></button>
          <button onclick="closeResumeModal()">关闭</button>
        </div>
      </div>
      <div id="rm-modal-body"></div>
    </div>
  </div>

  <div class="bottom-nav">
    <button class="nav-btn active" data-p="jobs" onclick="goTab('jobs')">${svgTag('briefcase', 20)}<span>搜岗简历</span></button>
    <button class="nav-btn" data-p="prep" onclick="goTab('prep')">${svgTag('target', 20)}<span>面试题库</span></button>
    <button class="nav-btn" data-p="career" onclick="goTab('career')">${svgTag('compass', 20)}<span>职业规划</span></button>
    <button class="nav-btn" data-p="chat" onclick="goTab('chat')">${svgTag('message', 20)}<span>聊天回复</span></button>
    <button class="nav-btn" data-p="salary" onclick="goTab('salary')">${svgTag('wallet', 20)}<span>谈薪设置</span></button>
  </div>
  <div id="toast" class="toast"></div>

<script>
const DATA = ${safeJsonForScript(payload)};
const ICONS = ${safeJsonForScript(SVG_PATHS)};
const STORE_KEY = DATA.mode === 'personal' ? 'job_copilot_mobile_personal_v3' : 'job_copilot_mobile_generic_v3';
let state = {};
try { state = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { state = {}; }
if (!state.practiced) state.practiced = {};
if (!state.careerDone) state.careerDone = {};
if (!state.customQuestions) state.customQuestions = {};
if (!state.customJobs) state.customJobs = [];
if (!state.customCareerPlan) state.customCareerPlan = null;
if (!state.mobileResume) state.mobileResume = null;
if (!state.mobileApi) state.mobileApi = { provider: 'deepseek', apiKey: '' };

let resumeExpList = [];
let prepCatFilter = '';

function ico(name, size) {
  const s = size || 16;
  return '<span class="ico"><svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg></span>';
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

function esc(s) { return String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function escAttr(s) { return esc(s).replaceAll('"','&quot;').replaceAll("'",'&#39;'); }

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(window.__t);
  window.__t = setTimeout(() => { el.style.display = 'none'; }, 2800);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('已复制！直接粘贴使用');
  } catch {
    toast('复制失败，请长按文本手动复制');
  }
}

function goTab(id) {
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'p-' + id));
  document.querySelectorAll('.nav-btn, .dnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.p === id));
  window.scrollTo(0, 0);
}

function switchJobsSubView(view) {
  const isResume = view === 'resume';
  document.getElementById('sub-jobs-search').style.display = isResume ? 'none' : 'block';
  document.getElementById('sub-jobs-resume').style.display = isResume ? 'block' : 'none';
  document.getElementById('seg-btn-search').classList.toggle('active', !isResume);
  document.getElementById('seg-btn-resume').classList.toggle('active', isResume);
  window.scrollTo(0, 0);
}

function updateResumeStatusUI() {
  const r = state.mobileResume;
  const hasExp = Array.isArray(r?.experiences) && r.experiences.some((e) => e.company || e.role || e.highlights);
  const filled = Boolean(r && (r.summary || r.skills || r.exp || hasExp));
  const pill = document.getElementById('resume-status-pill');
  const banner = document.getElementById('resume-guide-banner');
  if (pill) {
    pill.textContent = filled ? '已填' : '未填';
    pill.className = 'pill ' + (filled ? 'green' : '');
    pill.style.fontSize = '11.5px';
    pill.style.padding = '1px 7px';
  }
  if (banner) {
    banner.style.display = filled ? 'none' : 'flex';
  }
}

/* ===== 13 大全行业智能匹配引擎 ===== */
function detectTemplateClient(title, extraText) {
  const hay = ((title || '') + ' ' + (extraText || '')).toLowerCase();
  const titleLow = String(title || '').toLowerCase();
  let best = DATA.roleTemplates[DATA.roleTemplates.length - 1];
  let bestScore = 0;
  for (const tpl of DATA.roleTemplates) {
    let score = 0;
    for (const kw of (tpl.keywords || [])) {
      const k = kw.toLowerCase();
      if (hay.includes(k)) score += titleLow.includes(k) ? 3 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = tpl;
    }
  }
  return best;
}

function buildGroupedTemplateOptions() {
  const groups = new Map();
  for (const t of DATA.roleTemplates) {
    const g = t.group || '通用';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  return [...groups.entries()]
    .map(([g, list]) => \`<optgroup label="\${escAttr(g)}">\${list.map((t) => \`<option value="\${escAttr(t.id)}">\${esc(t.name)}（\${(t.questions || []).length}题）</option>\`).join('')}</optgroup>\`)
    .join('');
}

function normalizeExperiencesFromResume(r) {
  if (Array.isArray(r?.experiences) && r.experiences.length) {
    return r.experiences.map((e) => ({
      company: String(e.company || ''),
      role: String(e.role || ''),
      period: String(e.period || ''),
      highlights: Array.isArray(e.highlights) ? e.highlights.join('\\n') : String(e.highlights || ''),
    }));
  }
  if (r?.exp && String(r.exp).trim()) {
    return [{ company: '核心工作 / 项目经历', role: '', period: '', highlights: String(r.exp).trim() }];
  }
  return [{ company: '', role: '', period: '', highlights: '' }];
}

function renderMobileExpCards() {
  const box = document.getElementById('mr-exp-cards');
  if (!box) return;
  if (!resumeExpList.length) {
    resumeExpList = [{ company: '', role: '', period: '', highlights: '' }];
  }
  box.innerHTML = resumeExpList.map((e, idx) => \`
    <div class="exp-card">
      <div class="row between" style="margin-bottom:8px;">
        <strong style="font-size:14.5px; color:#1e3a8a;">经历 #\${idx + 1}</strong>
        \${resumeExpList.length > 1 ? \`<button class="sm-btn danger" onclick="removeMobileExpItem(\${idx})">\${ico('trash', 14)}<span>删除</span></button>\` : ''}
      </div>
      <div class="row">
        <div class="field" style="flex:1; min-width:140px;"><label>公司 / 学校组织</label><input value="\${escAttr(e.company)}" placeholder="如：某某科技 / 某社团" oninput="updateMobileExpField(\${idx}, 'company', this.value)" /></div>
        <div class="field" style="flex:1; min-width:130px;"><label>担任职位 / 角色</label><input value="\${escAttr(e.role)}" placeholder="如：产品运营 / 实习生" oninput="updateMobileExpField(\${idx}, 'role', this.value)" /></div>
      </div>
      <div class="field"><label>起止时间</label><input value="\${escAttr(e.period)}" placeholder="如：2023.06 - 2025.08" oninput="updateMobileExpField(\${idx}, 'period', this.value)" /></div>
      <div class="field" style="margin-bottom:0;"><label>核心职责与量化成果（每行一条）</label><textarea rows="3" placeholder="如：主导某项目实现转化率提升 35%，节省团队每周 10 小时人工成本" oninput="updateMobileExpField(\${idx}, 'highlights', this.value)">\${esc(e.highlights)}</textarea></div>
    </div>
  \`).join('');
}

function addMobileExpItem() {
  resumeExpList.push({ company: '', role: '', period: '', highlights: '' });
  renderMobileExpCards();
}

function removeMobileExpItem(idx) {
  resumeExpList.splice(idx, 1);
  renderMobileExpCards();
}

function updateMobileExpField(idx, key, val) {
  if (!resumeExpList[idx]) return;
  resumeExpList[idx][key] = val;
}

function fillResumeFormFromObj(r) {
  document.getElementById('mr-name').value = r?.name || '';
  document.getElementById('mr-contact').value = r?.contact || '';
  document.getElementById('mr-basic').value = r?.basic || '';
  document.getElementById('mr-stage').value = r?.stage || 'mid_career';
  document.getElementById('mr-summary').value = r?.summary || '';
  document.getElementById('mr-skills').value = r?.skills || '';
  document.getElementById('mr-edu').value = r?.edu || '';
  resumeExpList = normalizeExperiencesFromResume(r);
  renderMobileExpCards();
}

async function browserInflateBytes(u8, format) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器版本较旧不支持内置解压，请更新浏览器或粘贴文本');
  }
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  writer.write(u8);
  writer.close();
  const ab = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(ab);
}

async function extractDocxTextInBrowser(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const minPos = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无效的 .docx 文件');
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  let docXml = '';
  for (let i = 0; i < count; i++) {
    if (off + 46 > bytes.length || view.getUint32(off, true) !== 0x02014b50) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen)).toLowerCase();
    off += 46 + nameLen + extraLen + commentLen;
    if (name !== 'word/document.xml') continue;
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const slice = bytes.subarray(start, start + compSize);
    const raw = method === 0 ? slice : await browserInflateBytes(slice, 'deflate-raw');
    docXml = dec.decode(raw);
    break;
  }
  if (!docXml) throw new Error('未在 .docx 中找到正文内容');
  return docXml
    .replace(/<w:tab\\b[^>]*\\/>/g, ' | ')
    .replace(/<w:br\\b[^>]*\\/>/g, '\\n')
    .replace(/<\\/w:tc>/g, ' | ')
    .replace(/<\\/w:tr>/g, '\\n')
    .replace(/<\\/w:p>/g, '\\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
    .split(/\\r?\\n/).map((s) => s.replace(/\\s+/g, ' ').trim()).filter(Boolean).join('\\n');
}

function pdfHexToUnicodeClient(hexStr) {
  const clean = String(hexStr || '').replace(/\\s+/g, '');
  let out = '';
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    const c = parseInt(clean.slice(i, i + 4), 16);
    if (!Number.isNaN(c) && c > 0) out += String.fromCharCode(c);
  }
  return out;
}

function parsePdfCMapClient(txt, cmap) {
  const charBlocks = txt.match(/beginbfchar[\\s\\S]*?endbfchar/g) || [];
  for (const b of charBlocks) {
    for (const m of b.matchAll(/<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]+)>/g)) {
      const dst = pdfHexToUnicodeClient(m[2]);
      if (dst) cmap.set(m[1].toUpperCase(), dst);
    }
  }
  const rangeBlocks = txt.match(/beginbfrange[\\s\\S]*?endbfrange/g) || [];
  for (const b of rangeBlocks) {
    for (const m of b.matchAll(/<([0-9a-fA-F]+)>\\s*<([0-9a-fA-F]+)>\\s*(?:<([0-9a-fA-F]+)>|\\[([^\\]]+)\\])/g)) {
      const sh = m[1].toUpperCase();
      const eh = m[2].toUpperCase();
      const w = sh.length;
      const sc = parseInt(sh, 16);
      const ec = parseInt(eh, 16);
      if (Number.isNaN(sc) || Number.isNaN(ec) || ec - sc > 8192) continue;
      if (m[3]) {
        const bh = m[3];
        if (bh.length <= 4) {
          let dc = parseInt(bh, 16);
          for (let c = sc; c <= ec; c++) { cmap.set(c.toString(16).toUpperCase().padStart(w, '0'), String.fromCharCode(dc++)); }
        } else {
          const pre = bh.slice(0, -4);
          let lc = parseInt(bh.slice(-4), 16);
          for (let c = sc; c <= ec; c++) { cmap.set(c.toString(16).toUpperCase().padStart(w, '0'), pdfHexToUnicodeClient(pre + (lc++).toString(16).toUpperCase().padStart(4, '0'))); }
        }
      } else if (m[4]) {
        const arr = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => pdfHexToUnicodeClient(x[1]));
        for (let i = 0; i < arr.length && sc + i <= ec; i++) { if (arr[i]) cmap.set((sc + i).toString(16).toUpperCase().padStart(w, '0'), arr[i]); }
      }
    }
  }
}

function decodePdfHexClient(raw, cmap) {
  const clean = String(raw || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!clean) return '';
  if (clean.startsWith('FEFF') && clean.length >= 8) return pdfHexToUnicodeClient(clean.slice(4));
  if (cmap.size > 0 && clean.length % 4 === 0) {
    let out = ''; let hit = 0; const total = clean.length / 4;
    for (let i = 0; i < clean.length; i += 4) {
      const k = clean.slice(i, i + 4);
      if (cmap.has(k)) { out += cmap.get(k); hit++; }
      else { const code = parseInt(k, 16); if (code >= 32 && code < 127) out += String.fromCharCode(code); }
    }
    if (hit > 0 && hit >= total * 0.25) return out;
  }
  if (cmap.size > 0 && clean.length % 2 === 0) {
    let out = ''; let hit = 0;
    for (let i = 0; i < clean.length; i += 2) { const k = clean.slice(i, i + 2); if (cmap.has(k)) { out += cmap.get(k); hit++; } }
    if (hit > 0) return out;
  }
  let ascii = '';
  for (let i = 0; i + 2 <= clean.length; i += 2) { const code = parseInt(clean.slice(i, i + 2), 16); if (code >= 32 && code < 127) ascii += String.fromCharCode(code); }
  return ascii;
}

function decodePdfLitClient(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\\\' && i + 1 < raw.length) {
      const nx = raw[i + 1];
      if (nx === 'n') { out += '\\n'; i++; }
      else if (nx === 'r') { out += '\\r'; i++; }
      else if (nx === 't') { out += '\\t'; i++; }
      else if (nx === '(' || nx === ')' || nx === '\\\\') { out += nx; i++; }
      else if (/[0-7]/.test(nx)) { const oct = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0]; out += String.fromCharCode(parseInt(oct, 8)); i += oct.length; }
      else { out += nx; i++; }
    } else out += raw[i];
  }
  return out;
}

function extractPdfStreamTextClient(txt, fontCmapByName, fallbackCmap) {
  const lines = []; let cur = ''; let activeCmap = fallbackCmap;
  const flush = () => { const t = cur.replace(/\\s+/g, ' ').trim(); if (t) lines.push(t); cur = ''; };
  const blocks = txt.match(/\\bBT\\b[\\s\\S]*?\\bET\\b/g) || [];
  for (const b of blocks) {
    let i = 0; const n = b.length; const stack = [];
    while (i < n) {
      const ch = b[i];
      if (/\\s/.test(ch)) { i++; continue; }
      if (ch === '/') {
        const s = i + 1; i++;
        while (i < n && !/[\\s\\[\\]()<>\\/%]/.test(b[i])) i++;
        stack.push({ t: 'name', v: b.slice(s, i) }); continue;
      }
      if (ch === '(') {
        let d = 1; const s = i + 1; i++;
        while (i < n && d > 0) { if (b[i] === '\\\\') { i += 2; continue; } if (b[i] === '(') d++; else if (b[i] === ')') d--; i++; }
        stack.push({ t: 's', v: decodePdfLitClient(b.slice(s, i - 1)) }); continue;
      }
      if (ch === '<' && b[i + 1] !== '<') {
        const end = b.indexOf('>', i + 1); if (end < 0) break;
        stack.push({ t: 'h', v: decodePdfHexClient(b.slice(i + 1, end), activeCmap) }); i = end + 1; continue;
      }
      if (ch === '[') {
        const arr = []; i++;
        while (i < n && b[i] !== ']') {
          if (/\\s/.test(b[i])) i++;
          else if (b[i] === '(') {
            let d = 1; const s = i + 1; i++;
            while (i < n && d > 0) { if (b[i] === '\\\\') { i += 2; continue; } if (b[i] === '(') d++; else if (b[i] === ')') d--; i++; }
            arr.push({ t: 's', v: decodePdfLitClient(b.slice(s, i - 1)) });
          } else if (b[i] === '<') {
            const end = b.indexOf('>', i + 1); if (end < 0) break;
            arr.push({ t: 'h', v: decodePdfHexClient(b.slice(i + 1, end), activeCmap) }); i = end + 1;
          } else {
            const s = i; while (i < n && !/[\\s\\[\\]()<>]/.test(b[i])) i++;
            const num = Number(b.slice(s, i)); if (!Number.isNaN(num)) arr.push({ t: 'n', v: num });
          }
        }
        if (b[i] === ']') i++;
        stack.push({ t: 'a', v: arr }); continue;
      }
      const s = i; while (i < n && !/[\\s\\[\\]()<>\\/%]/.test(b[i])) i++;
      if (i === s) { i++; continue; }
      const tok = b.slice(s, i);
      if (tok === 'Tf') {
        const ni = [...stack].reverse().find((x) => x.t === 'name');
        if (ni && fontCmapByName.has(ni.v)) activeCmap = fontCmapByName.get(ni.v);
        stack.length = 0;
      } else if (tok === 'Tj' || tok === "'" || tok === '"') {
        if (tok !== 'Tj') flush();
        const it = stack.pop(); if (it && (it.t === 's' || it.t === 'h')) cur += it.v;
        stack.length = 0;
      } else if (tok === 'TJ') {
        const it = stack.pop();
        if (it && it.t === 'a') { for (const el of it.v) { if (el.t === 's' || el.t === 'h') cur += el.v; else if (el.t === 'n' && el.v < -220) cur += ' '; } }
        stack.length = 0;
      } else if (tok === 'T*' || tok === 'Tm') { flush(); stack.length = 0; }
      else if (tok === 'Td' || tok === 'TD') {
        const ty = Number(stack[stack.length - 1]?.v ?? 0);
        const tx = Number(stack[stack.length - 2]?.v ?? 0);
        if (Math.abs(ty) > 1.5) flush(); else if (tx > 60 && cur && !cur.endsWith(' ')) cur += ' ';
        stack.length = 0;
      } else if (/^[A-Za-z*']+$/.test(tok)) { stack.length = 0; }
      else { stack.push({ t: 'n', v: tok }); }
    }
    flush();
  }
  return lines.join('\\n');
}

async function extractPdfTextBuiltinClient(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const latin = new TextDecoder('latin1').decode(bytes);
  if (!latin.slice(0, 1024).includes('%PDF-')) throw new Error('不是合法的 PDF 文件');
  const cmapByObj = new Map();
  const fallbackCmap = new Map();
  const fontObjToCmapObj = new Map();
  const fontNameToObj = new Map();
  for (const m of latin.matchAll(/(\\d+)\\s+0\\s+obj\\b([\\s\\S]*?)endobj/g)) {
    const id = Number(m[1]); const body = m[2];
    const tu = body.match(/\\/ToUnicode\\s+(\\d+)\\s+0\\s+R/);
    if (tu) fontObjToCmapObj.set(id, Number(tu[1]));
    const fd = body.match(/\\/Font\\s*<<([\\s\\S]*?)>>/);
    if (fd) { for (const fm of fd[1].matchAll(/\\/([A-Za-z0-9_.-]+)\\s+(\\d+)\\s+0\\s+R/g)) fontNameToObj.set(fm[1], Number(fm[2])); }
  }
  const contentStreams = [];
  let pos = 0;
  while (true) {
    const idx = latin.indexOf('stream', pos);
    if (idx < 0) break;
    if (/[A-Za-z0-9]/.test(latin[idx - 1] || '\\n')) { pos = idx + 6; continue; }
    let start = idx + 6;
    if (latin[start] === '\\r' && latin[start + 1] === '\\n') start += 2;
    else if (latin[start] === '\\n' || latin[start] === '\\r') start += 1;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    pos = end + 9;
    const prefix = latin.slice(Math.max(0, idx - 900), idx);
    const oms = [...prefix.matchAll(/(\\d+)\\s+0\\s+obj\\b/g)];
    const curObjId = oms.length ? Number(oms[oms.length - 1][1]) : -1;
    let raw = bytes.subarray(start, end);
    if (/\\/FlateDecode\\b/.test(prefix)) {
      try { raw = await browserInflateBytes(raw, 'deflate'); }
      catch { try { raw = await browserInflateBytes(raw, 'deflate-raw'); } catch { continue; } }
    }
    let nulCnt = 0; for (let k = 0; k < Math.min(64, raw.length); k++) { if (raw[k] === 0) nulCnt++; }
    if (nulCnt > 4) continue;
    const txt = new TextDecoder('latin1').decode(raw);
    if (txt.includes('begincmap') || txt.includes('beginbfchar') || txt.includes('beginbfrange')) {
      const lm = new Map(); parsePdfCMapClient(txt, lm);
      if (curObjId >= 0) cmapByObj.set(curObjId, lm);
      for (const [k, v] of lm.entries()) { if (!fallbackCmap.has(k)) fallbackCmap.set(k, v); }
    } else if (/\\bBT\\b/.test(txt) && (txt.includes('Tj') || txt.includes('TJ'))) {
      contentStreams.push(txt);
    }
  }
  const fontCmapByName = new Map();
  for (const [fn, fo] of fontNameToObj.entries()) {
    const co = fontObjToCmapObj.get(fo);
    if (co !== undefined && cmapByObj.has(co)) fontCmapByName.set(fn, cmapByObj.get(co));
  }
  return contentStreams
    .map((s) => extractPdfStreamTextClient(s, fontCmapByName, fallbackCmap))
    .filter(Boolean)
    .join('\\n')
    .split(/\\r?\\n/)
    .map((l) => l.replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFD]/g, '').replace(/ {2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\\n');
}

async function extractPdfTextWithPdfJsFallback(arrayBuffer) {
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
      sc.onload = resolve;
      sc.onerror = () => reject(new Error('网络不可用，无法加载高级 PDF 引擎'));
      document.head.appendChild(sc);
    });
    if (window.pdfjsLib?.GlobalWorkerOptions) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    }
  }
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    let lastY = null; let line = ''; const pLines = [];
    for (const item of tc.items || []) {
      const y = item.transform ? Math.round(item.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
        if (line.trim()) pLines.push(line.trim());
        line = '';
      }
      line += (line && item.str && !line.endsWith(' ') && !item.str.startsWith(' ') ? ' ' : '') + (item.str || '');
      if (y !== null) lastY = y;
    }
    if (line.trim()) pLines.push(line.trim());
    pages.push(pLines.join('\\n'));
  }
  return pages.filter(Boolean).join('\\n');
}

function applyParsedPlainTextToResumeForm(raw, fileLabel) {
  const lines = String(raw || '').split(/\\r?\\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('未能提取到有效文字');
  const firstLine = lines[0] || '';
  const phoneM = raw.match(/(?<!\\d)1[3-9]\\d{9}(?!\\d)/);
  const emailM = raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);
  const contact = [phoneM?.[0], emailM?.[0]].filter(Boolean).join(' ｜ ');

  const summaryLines = [];
  const skillLines = [];
  const expLines = [];
  const eduLines = [];
  let basicLine = '';
  let sec = 'summary';

  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^(核心技能|专业技能|技能|核心能力|技能清单|技术栈)[:：\\s]*$/i.test(l)) { sec = 'skills'; continue; }
    if (/^(工作经历|工作经验|实习经历|项目经历|重点项目|实践经历)[:：\\s]*$/i.test(l)) { sec = 'exp'; continue; }
    if (/^(教育背景|教育经历|学历背景)[:：\\s]*$/i.test(l)) { sec = 'edu'; continue; }
    if (/^(个人优势|自我评价|个人简介|核心优势|求职意向)[:：\\s]*$/i.test(l)) { sec = 'summary'; continue; }
    if (!basicLine && i <= 4 && /(\\d+\\s*岁|大专|本科|硕士|博士|\\d+\\s*年.*经验|应届)/.test(l) && l.length <= 60) {
      basicLine = l;
      continue;
    }
    if (sec === 'skills') skillLines.push(l);
    else if (sec === 'exp') expLines.push(l);
    else if (sec === 'edu') eduLines.push(l);
    else summaryLines.push(l);
  }

  // 智能按时间段拆分成多段工作/项目经历卡片
  const periodRe = /((?:19|20)\\d{2}(?:[./年-]\\d{1,2}月?)?\\s*(?:-|–|—|~|～|至)\\s*(?:(?:19|20)\\d{2}(?:[./年-]\\d{1,2}月?)?|至今|现在))/;
  const exps = [];
  let curExp = null;
  for (const l of expLines) {
    const pm = l.match(periodRe);
    if (pm && l.length <= 90 && !/^[•·\\-*\\d]/.test(l)) {
      const rest = l.replace(pm[0], ' | ').replace(/^\\s*[|｜]+|\\s*[|｜]+$/g, '').trim();
      const parts = rest.split(/\\s*(?:\\||｜|\\u3000|\\s{2,})\\s*/).filter(Boolean);
      curExp = { company: parts[0] || rest, role: parts.slice(1).join(' / '), period: pm[1].trim(), highlights: '' };
      exps.push(curExp);
    } else {
      if (!curExp) { curExp = { company: '核心工作 / 项目经历', role: '', period: '', highlights: '' }; exps.push(curExp); }
      curExp.highlights += (curExp.highlights ? '\\n' : '') + l.replace(/^[•·●▪\\-*]+\\s*/, '');
    }
  }

  fillResumeFormFromObj({
    name: firstLine.length <= 14 && !/[:：]/.test(firstLine) ? firstLine : (state.mobileResume?.name || ''),
    contact: contact || (state.mobileResume?.contact || ''),
    basic: basicLine || (firstLine.length > 14 ? firstLine : (state.mobileResume?.basic || '')),
    stage: document.getElementById('mr-stage').value || 'mid_career',
    summary: summaryLines.join('\\n') || lines.slice(0, 5).join('\\n'),
    skills: skillLines.join('\\n'),
    experiences: exps.length ? exps : [{ company: '导入的经历（可点击右上角拆分为多段）', role: '', period: '', highlights: (expLines.length ? expLines : lines).join('\\n') }],
    edu: eduLines.join('；'),
  });
  saveMobileResume();
  toast('已成功解析 ' + fileLabel + ' 并填入表单且自动保存！');
}

async function importResumeTextFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith('.pdf')) {
      toast('正在本地浏览器解析 PDF 简历，请稍候...');
      const ab = await file.arrayBuffer();
      let text = '';
      try { text = await extractPdfTextBuiltinClient(ab); } catch {}
      const readableCount = (text.match(/[\\u4e00-\\u9fa5A-Za-z0-9]/g) || []).length;
      if (readableCount < 30) {
        try { text = await extractPdfTextWithPdfJsFallback(ab); } catch {}
      }
      if (!text || (text.match(/[\\u4e00-\\u9fa5A-Za-z0-9]/g) || []).length < 10) {
        throw new Error('未能从该 PDF 提取到文字（可能是纯图片扫描版 PDF），建议直接复制文字粘贴或上传 .docx');
      }
      applyParsedPlainTextToResumeForm(text, file.name);
      return;
    }
    if (lower.endsWith('.docx')) {
      toast('正在本地浏览器解析 Word (.docx) 简历...');
      const ab = await file.arrayBuffer();
      const text = await extractDocxTextInBrowser(ab);
      applyParsedPlainTextToResumeForm(text, file.name);
      return;
    }
    const raw = (await file.text()).trim();
    if (!raw) return toast('文件内容为空');
    if (lower.endsWith('.json')) {
      const parsed = JSON.parse(raw);
      const mapped = {
        name: parsed.name || '',
        contact: parsed.contact || '',
        basic: parsed.basic || parsed.basicInfo || parsed.headline || '',
        stage: parsed.stage || 'mid_career',
        summary: Array.isArray(parsed.summary) ? parsed.summary.join('\\n') : (parsed.summary || ''),
        skills: Array.isArray(parsed.skills) ? parsed.skills.join('\\n') : (parsed.skills || ''),
        experiences: Array.isArray(parsed.experiences)
          ? parsed.experiences.map((e) => ({
              company: e.company || '',
              role: e.role || '',
              period: e.period || '',
              highlights: Array.isArray(e.highlights) ? e.highlights.join('\\n') : (e.highlights || ''),
            }))
          : [],
        edu: Array.isArray(parsed.education)
          ? parsed.education.map((e) => [e.school, e.degree, e.period].filter(Boolean).join(' · ')).join('；')
          : (parsed.edu || ''),
      };
      fillResumeFormFromObj(mapped);
      saveMobileResume();
      toast('已从 JSON 简历导入并保存！');
      return;
    }
    applyParsedPlainTextToResumeForm(raw, file.name);
  } catch (e) {
    toast('解析失败：' + e.message);
  }
}

function initSelectors() {
  const groupedHtml = buildGroupedTemplateOptions();
  ['m-prep-tpl', 'ms-tpl', 'mj-tpl'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = groupedHtml;
  });

  if (DATA.jobs.length > 0) {
    document.getElementById('m-prep-job-wrap').style.display = 'block';
    refreshPrepJobSelect();
    if (DATA.jobs[0]?.templateId) {
      document.getElementById('m-prep-tpl').value = DATA.jobs[0].templateId;
      document.getElementById('ms-tpl').value = DATA.jobs[0].templateId;
    }
  }

  const scenes = Object.keys(DATA.quickChatBank || {});
  document.getElementById('m-chat-scene').innerHTML =
    '<option value="自动识别">自动识别 HR 意图（推荐）</option>' +
    scenes.map((s) => \`<option value="\${escAttr(s)}">\${esc(s)}</option>\`).join('');
  if (typeof refreshChatJobSelect === 'function') refreshChatJobSelect();

  // 初始化简历底稿表单
  const r = state.mobileResume || (DATA.masterResume ? {
    name: '',
    contact: '',
    basic: DATA.masterResume.basicInfo || '',
    stage: 'mid_career',
    summary: DATA.masterResume.summary || '',
    skills: (DATA.masterResume.skills || []).join('\\n'),
    experiences: (DATA.masterResume.experiences || []).map((e) => ({
      company: e.company || '',
      role: e.role || '',
      period: e.period || '',
      highlights: [
        ...(e.highlights || []),
        ...(e.subProjects || []).map((sp) => \`【\${sp.name} \${sp.period}】\${(sp.highlights || []).join('；')}\`),
      ].join('\\n'),
    })),
    edu: (DATA.masterResume.education || []).map((e) => \`\${e.school} · \${e.degree} · \${e.period}\`).join('；'),
  } : null);
  fillResumeFormFromObj(r);
  updateResumeStatusUI();

  document.getElementById('ma-provider').value = state.mobileApi?.provider || 'deepseek';
  document.getElementById('ma-key').value = state.mobileApi?.apiKey || '';
  updateSearchLinks();
}

/* ===== 联网精准搜岗直达 ===== */
function updateSearchLinks() {
  const city = document.getElementById('s-city').value.trim() || '上海';
  const kw = document.getElementById('s-kw').value.trim() || 'AI产品经理';
  const matched = detectTemplateClient(kw, '');
  document.getElementById('s-match-hint').innerHTML = \`已智能匹配行业：<strong>\${esc(matched.name)}</strong>（含 \${(matched.questions || []).length} 道深度题，点击下方平台直达真实在招岗位）\`;
  const q = encodeURIComponent(kw);
  const cq = encodeURIComponent(city + ' ' + kw);
  const links = [
    { label: 'Boss直聘搜岗位', url: \`https://www.zhipin.com/web/geek/job?query=\${q}\`, primary: true },
    { label: '猎聘搜岗位', url: \`https://www.liepin.com/zhaopin/?key=\${q}\` },
    { label: '智联搜岗位', url: \`https://sou.zhaopin.com/?kw=\${q}\` },
    { label: '实习僧(应届/实习)', url: \`https://www.shixiseng.com/interns?keyword=\${q}\` },
    { label: '全网公开JD搜索', url: \`https://www.bing.com/search?q=\${cq}+招聘+JD\` },
  ];
  document.getElementById('s-links').innerHTML =
    links.map((l) => \`<a class="link-btn \${l.primary ? 'primary' : ''}" href="\${escAttr(l.url)}" target="_blank" rel="noopener">\${esc(l.label)}</a>\`).join('') +
    \`<button onclick="jumpToTemplate('\${escAttr(matched.id)}', 'prep')">\${ico('target', 16)}<span>刷该行业 \${(matched.questions || []).length} 道题</span></button>\`;
}

/* ===== 手机/全端三档智能荐岗（Gemini 原生联网搜索 + 零 Key 多批策略与模式 B 追加导入） ===== */
const MOBILE_TIER_META = {
  practice: { label: '练手训练', color: 'green', desc: '门槛友好 · 先约面刷手感与测报价' },
  core: { label: '主力匹配', color: 'blue', desc: '经历与薪资最契合 · 核心冲 Offer' },
  stretch: { label: '进阶挑战', color: 'amber', desc: '薪资/平台高一档 · 用量化成果破格跃迁' },
};
let mobileRecList = [];
let mobileRecModeLabel = '';
let mobileRecBatch = 0;
const mobileDismissedKeys = new Set();

function mobileRecKey(c) {
  return String(c?.company || '').trim().toLowerCase() + '|' + String(c?.title || '').trim().toLowerCase();
}

function parseMobileSalaryMid(salaryText) {
  const s = String(salaryText || '').replace(/,/g, '');
  const km = s.match(/(\\d+(?:\\.\\d+)?)\\s*[-~～至]\\s*(\\d+(?:\\.\\d+)?)\\s*[kK千]/);
  if (km) return (Number(km[1]) + Number(km[2])) / 2;
  const wm = s.match(/(\\d+(?:\\.\\d+)?)\\s*[-~～至]\\s*(\\d+(?:\\.\\d+)?)\\s*万/);
  if (wm) {
    const a = Number(wm[1]);
    const b = Number(wm[2]);
    return a >= 10 || /年/.test(s) ? ((a + b) * 5) / 12 : (a + b) * 5;
  }
  const sk = s.match(/(\\d+(?:\\.\\d+)?)\\s*[kK千]/);
  return sk ? Number(sk[1]) : 0;
}

function renderMobileRecResults() {
  const box = document.getElementById('m-rec-results');
  if (!box) return;
  if (!mobileRecList.length) {
    box.innerHTML = '<div class="box muted">当前推荐池为空，点击上方「根据简历生成三档推荐」或展开「模式 B」导入联网搜回的企业岗位。</div>';
    return;
  }
  const groups = ['practice', 'core', 'stretch'];
  const hintLine = mobileRecModeLabel.includes('零 Key')
    ? '<br/>说明：纯静态网页受浏览器安全策略限制，未填 Key 时展示多细分方向「三档策略靶标」（每档多条且可点「+ 换一批」持续追加）；如需<strong>网页直连实时抓真实公司</strong>，可在「谈薪与设置」填入免费 Gemini Key，或点上方「模式 B」让联网 AI 搜出真实公司 JSON 贴进来。'
    : '';
  box.innerHTML =
    \`<div class="box" style="margin-top:0; margin-bottom:8px; background:#fffbeb; border-color:#fde68a; color:#78350f; font-size:13.5px;"><strong>当前模式：\${esc(mobileRecModeLabel)}</strong>（共 <strong>\${mobileRecList.length}</strong> 个候选，支持切换档位与移除）\${hintLine}</div>\` +
    groups.map((tId) => {
      const meta = MOBILE_TIER_META[tId];
      const list = mobileRecList.filter((c) => c.tier === tId);
      return \`
        <div class="box" style="margin-top:8px; background:#fff;">
          <div class="row between" style="margin-bottom:6px;">
            <span class="pill \${meta.color}">\${esc(meta.label)}（\${list.length}）</span>
            <span class="muted">\${esc(meta.desc)}</span>
          </div>
          \${list.length ? list.map((c) => \`
            <div style="border-top:1px dashed #e2e8f0; padding-top:8px; margin-top:8px;">
              <div class="row between">
                <strong>\${esc(c.company)} · \${esc(c.title)}</strong>
                <span class="pill green">\${c.match_score}分</span>
              </div>
              <div class="muted" style="margin-top:3px;">\${esc(c.city)} ｜ \${esc(c.salary)}\${c.platform ? ' ｜ ' + esc(c.platform) : ''}</div>
              <div style="font-size:13.5px; margin-top:4px;">\${esc(c.tier_reason)}</div>
              <div class="row" style="margin-top:8px; gap:6px;">
                <select aria-label="切换档位" style="width:auto; padding:6px 8px; font-size:13px;" onchange="moveMobileRecTier('\${escAttr(c.id)}', this.value)">
                  <option value="practice" \${tId === 'practice' ? 'selected' : ''}>练手训练</option>
                  <option value="core" \${tId === 'core' ? 'selected' : ''}>主力匹配</option>
                  <option value="stretch" \${tId === 'stretch' ? 'selected' : ''}>进阶挑战</option>
                </select>
                <button class="danger sm-btn" onclick="removeMobileRecItem('\${escAttr(c.id)}')">移除</button>
                <a class="link-btn sm-btn" href="\${escAttr(c.url)}" target="_blank" rel="noopener">搜实招原岗</a>
                <button class="success sm-btn" style="flex:1; min-width:165px;" onclick="adoptMobileRecommendedJob('\${escAttr(c.id)}')">\${ico('check', 15)}<span>加入目标岗位并生成简历+话术</span></button>
              </div>
            </div>
          \`).join('') : '<div class="muted" style="padding:6px 0;">本档暂无候选，可点「+ 换一批 / 加更多岗位」或从其他档调入</div>'}
        </div>
      \`;
    }).join('');
}

function moveMobileRecTier(recId, newTier) {
  if (!['practice', 'core', 'stretch'].includes(newTier)) return;
  const idx = mobileRecList.findIndex((x) => x.id === recId);
  if (idx < 0) return;
  mobileRecList[idx].tier = newTier;
  renderMobileRecResults();
  toast('已调整至「' + (MOBILE_TIER_META[newTier]?.label || newTier) + '」');
}

function removeMobileRecItem(recId) {
  const idx = mobileRecList.findIndex((x) => x.id === recId);
  if (idx < 0) return;
  const [removed] = mobileRecList.splice(idx, 1);
  const k = mobileRecKey(removed);
  if (k !== '|') mobileDismissedKeys.add(k);
  renderMobileRecResults();
  toast('已移除「' + removed.company + '」');
}

function mergeMobileCandidates(incoming, appendMode) {
  if (!appendMode) {
    mobileRecList = [];
  }
  const seen = new Set(mobileRecList.map(mobileRecKey));
  let added = 0;
  for (const item of incoming || []) {
    const k = mobileRecKey(item);
    if (k === '|' || seen.has(k) || mobileDismissedKeys.has(k)) continue;
    seen.add(k);
    mobileRecList.push(item);
    added += 1;
  }
  return added;
}

function buildMobileStrategyBatch(city, kw, sal, matched, batchIdx) {
  const lowMin = Math.max(5, Math.round(sal * 0.78));
  const lowMax = Math.round(sal * 0.98);
  const midMin = Math.round(sal * 0.95);
  const midMax = Math.round(sal * 1.25);
  const highMin = Math.round(sal * 1.25);
  const highMax = Math.round(sal * 1.65);
  const baseRole = kw.replace(/^(高级|资深|首席|初级)/, '').replace(/(负责人|总监|主管)$/, '').trim() || kw;
  const ts = Date.now() + '_' + batchIdx;

  const variants = [
    {
      p: ['成长型小团队（练手热身）', '初创垂直业务线（刷面试手感）'],
      c: ['垂类优质企业（主力靶标）', '稳健增长团队（高契合主攻）'],
      s: ['头部平台 / 上市团队（进阶冲刺）', '高潜独角兽业务线（薪资跃迁）'],
    },
    {
      p: ['区域中小型公司（保底试面）', '新锐代运营 / 服务商团队（练话术）'],
      c: ['品牌自营核心部门（主力方向）', '盈利型成熟业务线（稳健冲 Offer）'],
      s: ['集团创新事业部（管理突破）', '跨区域 / 出海增长团队（高溢价岗）'],
    },
    {
      p: ['急招补位业务团队（高约面率）', '精细化执行小团队（测报价反应）'],
      c: ['行业中腰部标杆企业（核心匹配）', '多条线并行业务组（技能全对齐）'],
      s: ['头部大厂生态核心岗（履历背书）', '0-1 牵头攻坚团队（高回报挑战）'],
    },
  ];
  const v = variants[batchIdx % variants.length];
  const suffix = batchIdx >= variants.length ? ' · 扩展批' + (batchIdx + 1) : '';

  return [
    {
      id: 'mrec_p1_' + ts,
      tier: 'practice',
      company: \`\${city}\${v.p[0]}\${suffix}\`,
      title: \`\${baseRole}（面试热身岗）\`,
      city: \`\${city} · 建议核实双休\`,
      salary: \`\${lowMin}-\${lowMax}K\`,
      url: \`https://www.zhipin.com/web/geek/job?query=\${encodeURIComponent(baseRole)}\`,
      match_score: 90,
      tier_reason: '门槛友好、约面概率高，适合先拿 2 场真实面试测试自我介绍节奏与追问反应。',
      jd_text: \`核心职责：独立推进 \${baseRole} 日常业务落地与数据复盘，匹配 \${matched.greetingFocus}。\`,
      platform: '三档策略靶标',
    },
    {
      id: 'mrec_p2_' + ts,
      tier: 'practice',
      company: \`\${city}\${v.p[1]}\${suffix}\`,
      title: \`资深\${baseRole}执行岗\`,
      city: \`\${city} · 门槛友好\`,
      salary: \`\${lowMin}-\${Math.round(sal * 1.02)}K\`,
      url: \`https://www.liepin.com/zhaopin/?key=\${encodeURIComponent(baseRole)}\`,
      match_score: 88,
      tier_reason: '业务复杂度适中，适合借此验证用人方对薪资底线和转岗/空窗解释的真实反馈。',
      jd_text: \`核心职责：承担 \${baseRole} 日常运营与项目交付，保障核心指标稳定达成。\`,
      platform: '三档策略靶标',
    },
    {
      id: 'mrec_c1_' + ts,
      tier: 'core',
      company: \`\${city}\${v.c[0]}\${suffix}\`,
      title: kw,
      city: \`\${city} · 双休优先\`,
      salary: \`\${midMin}-\${midMax}K\`,
      url: \`https://www.zhipin.com/web/geek/job?query=\${encodeURIComponent(kw)}\`,
      match_score: 93,
      tier_reason: \`与你简历底稿、核心技能（\${matched.name}）及 \${sal}K 目标薪资最贴合，建议重点精力冲 Offer。\`,
      jd_text: \`核心职责：全面负责 \${kw} 核心指标达成、流程优化与跨团队协同，重点考察 \${matched.greetingFocus}。\`,
      platform: '三档策略靶标',
    },
    {
      id: 'mrec_c2_' + ts,
      tier: 'core',
      company: \`\${city}\${v.c[1]}\${suffix}\`,
      title: kw.includes(baseRole) ? \`高级\${baseRole}\` : kw,
      city: \`\${city} · 重点主攻\`,
      salary: \`\${Math.round(sal * 1.0)}-\${Math.round(sal * 1.32)}K\`,
      url: \`https://www.liepin.com/zhaopin/?key=\${encodeURIComponent(kw)}\`,
      match_score: 91,
      tier_reason: '岗位权责与过往实战最同频，适合作为同步谈薪比价的第二主力梯队。',
      jd_text: \`核心职责：围绕 \${kw} 制定阶段打法并推进落地，沉淀可复制的增长经验。\`,
      platform: '三档策略靶标',
    },
    {
      id: 'mrec_s1_' + ts,
      tier: 'stretch',
      company: \`\${city}\${v.s[0]}\${suffix}\`,
      title: /负责人|总监|架构师|专家/.test(kw) ? \`高级\${baseRole}总监\` : \`\${baseRole}负责人 / 专家\`,
      city: \`\${city} · 大平台背书\`,
      salary: \`\${highMin}-\${highMax}K\`,
      url: \`https://www.bing.com/search?q=\${encodeURIComponent(city + ' ' + kw + ' 负责人 招聘')}\`,
      match_score: 83,
      tier_reason: '薪资与平台跃迁一档，适合用你最硬核的量化增量成果和系统方法论争取破格面试。',
      jd_text: \`核心职责：主导 \${baseRole} 战略规划、高阶项目攻坚与团队提效，看重从 0-1 或大规模拿结果能力。\`,
      platform: '三档策略靶标',
    },
    {
      id: 'mrec_s2_' + ts,
      tier: 'stretch',
      company: \`\${city}\${v.s[1]}\${suffix}\`,
      title: \`\${baseRole}团队Leader / 资深专家\`,
      city: \`\${city} · 高薪冲刺\`,
      salary: \`\${Math.round(sal * 1.3)}-\${Math.round(sal * 1.75)}K\`,
      url: \`https://www.zhipin.com/web/geek/job?query=\${encodeURIComponent(baseRole + ' 负责人')}\`,
      match_score: 80,
      tier_reason: '对跨部门统筹或更高业务体量有要求，面试前准备 1 份完整破局复盘即可冲刺。',
      jd_text: \`核心职责：负责核心业务线全局规划与团队管理，推动营收或效率实现跨越式增长。\`,
      platform: '三档策略靶标',
    },
  ];
}

function buildThreeGreetingsForMobile(job, tier) {
  const r = state.mobileResume || {};
  const firstHl = String(r.summary || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean)[0] || '具备扎实的一线实战与独立拿结果经验';
  const cleanHl = firstHl.replace(/^[•·\\-*\\d.、\\s]+/, '').slice(0, 62);
  const basic = r.basic ? \`（\${r.basic}）\` : '';
  return [
    {
      style: '直给成果型（推荐）',
      text: \`您好！看到贵司（\${job.company}）在招「\${job.title}」，我的背景与岗位非常契合\${basic}。过往实战中，\${cleanHl}。已针对该岗位整理好适配简历，方便发您进一步评估并约时间交流吗？\`,
    },
    {
      style: '业务切入型',
      text: \`您好！关注到贵司「\${job.title}」的招聘需求，我擅长把业务目标拆解成清晰指标并落地拿结果（例如：\${cleanHl}）。很想进一步了解咱们团队接下来的核心发力点，方便把简历发您参考吗？\`,
    },
    {
      style: tier === 'stretch' ? '破格冲刺亮数据型' : '高效约面沟通型',
      text: tier === 'stretch'
        ? \`您好！非常认可贵司「\${job.title}」的平台空间。我属于能直接上手扛指标的实战型人选，过往做到：\${cleanHl}。希望能有机会用具体项目复盘展示即战力，方便发份适配简历给您看下吗？\`
        : \`您好！看到贵司「\${job.title}」的需求后觉得非常同频，\${cleanHl}。如果岗位目前还在推进面试，我随时方便发简历并配合线上或线下交流，期待您的回复！\`,
    },
  ];
}

async function runMobileTierRecommend(appendMode = false) {
  const isAppend = Boolean(appendMode && mobileRecList.length);
  const r = state.mobileResume || {};
  const city = document.getElementById('s-city').value.trim() || '上海';
  const rawKw = document.getElementById('s-kw').value.trim();
  const resumeKw = String(r.basic || r.skills || '').split(/[｜|、,，\\/\\n]+/).map((s) => s.trim()).find((s) => s.length >= 2 && s.length <= 16 && !/^\\d+岁$|^(男|女|本科|大专|硕士|博士)$/.test(s)) || '';
  const kw = rawKw || resumeKw || 'AI产品经理';
  const sal = Math.max(5, Number(document.getElementById('s-sal').value) || 18);
  const matched = detectTemplateClient(kw, (r.summary || '') + ' ' + (r.skills || ''));
  const box = document.getElementById('m-rec-results');
  const btn = document.getElementById('btn-m-rec');
  const moreBtn = document.getElementById('btn-m-rec-more');
  btn.disabled = true;
  if (moreBtn) moreBtn.disabled = true;

  if (!isAppend) {
    mobileRecBatch = 0;
    mobileDismissedKeys.clear();
    box.innerHTML = '<div class="box">正在结合你的简历底稿生成「练手训练 / 主力匹配 / 进阶挑战」三档推荐...</div>';
  } else {
    mobileRecBatch += 1;
    toast('正在为你追加下一批三档岗位...');
  }

  let candidates = [];
  let modeLabel = '本地简历三档策略推荐（零 Key）';

  // 若配置了 Gemini 官方 Key，尝试直接调用 Gemini 原生 Google Search 联网抓真实在招岗位
  if (state.mobileApi?.provider === 'gemini' && state.mobileApi?.apiKey) {
    try {
      const existingCos = isAppend
        ? [...new Set(mobileRecList.map((x) => x.company).filter(Boolean))].slice(0, 15)
        : [];
      const excludeHint = existingCos.length ? '。请避开以下已出现公司：' + existingCos.join('、') : '';
      const count = isAppend ? 6 : 9;
      const per = isAppend ? 2 : 3;
      const prompt = \`请使用联网搜索查找「\${city}」地区当前真实在招的「\${kw}」岗位（目标月薪 \${sal}K 左右），按练手训练(practice)、主力匹配(core)、进阶挑战(stretch)各选\${per}个共\${count}个真实岗位\${excludeHint}。只输出纯 JSON 数组：[{"tier":"practice|core|stretch","company":"公司名","title":"岗位名","city":"城市","salary":"薪资","url":"链接","match_score":86,"tier_reason":"推荐理由","jd_text":"核心要求摘要"}]\`;
      const resp = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=\${encodeURIComponent(state.mobileApi.apiKey)}\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: [{ google_search: {} }], contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
      });
      const d = await resp.json();
      const txt = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\\n');
      const m = txt.match(/\\[[\\s\\S]*\\]/);
      if (resp.ok && m) {
        const parsed = JSON.parse(m[0]);
        if (Array.isArray(parsed) && parsed.length >= 2) {
          candidates = parsed.map((x, idx) => ({
            id: 'mrec_' + Date.now() + '_' + idx,
            tier: ['practice', 'core', 'stretch'].includes(x.tier) ? x.tier : 'core',
            company: x.company || '联网检索企业',
            title: x.title || kw,
            city: x.city || city,
            salary: x.salary || \`\${sal}-\${Math.round(sal * 1.25)}K\`,
            url: x.url || \`https://www.zhipin.com/web/geek/job?query=\${encodeURIComponent(x.title || kw)}\`,
            match_score: Number(x.match_score) || 85,
            tier_reason: x.tier_reason || 'Gemini 联网检索匹配岗位',
            jd_text: x.jd_text || \`\${x.company} \${x.title} 核心岗位要求\`,
            platform: 'Gemini联网搜索',
          }));
          modeLabel = 'Gemini 联网实时搜岗';
        }
      }
    } catch {
      // 降级本地三档策略推荐
    }
  }

  if (!candidates.length) {
    candidates = buildMobileStrategyBatch(city, kw, sal, matched, mobileRecBatch);
  }

  mobileRecModeLabel = modeLabel;
  const addedCount = mergeMobileCandidates(candidates, isAppend);
  renderMobileRecResults();

  btn.disabled = false;
  if (moreBtn) moreBtn.disabled = false;
  toast(isAppend ? \`已追加 \${addedCount} 个推荐岗位，当前共 \${mobileRecList.length} 个\` : \`已生成 \${mobileRecList.length} 个三档推荐，可随时增减或调档！\`);
}

function copyMobileCollabRecPrompt() {
  const r = state.mobileResume || {};
  const city = document.getElementById('s-city').value.trim() || '上海';
  const rawKw = document.getElementById('s-kw').value.trim();
  const resumeKw = String(r.basic || r.skills || '').split(/[｜|、,，\\/\\n]+/).map((s) => s.trim()).find((s) => s.length >= 2 && s.length <= 16) || '';
  const kw = rawKw || resumeKw || 'AI产品经理';
  const sal = Math.max(5, Number(document.getElementById('s-sal').value) || 18);
  const prompt = \`请使用联网搜索，帮我查找「\${city}」地区当前真实在招的「\${kw}」岗位（目标月薪基准 \${sal}K 左右），精选 12 个真实企业岗位（练手训练、主力匹配、进阶挑战各约 4 个）。只输出纯 JSON 数组：[{"company":"真实公司名","title":"岗位名","city":"\${city}","salary":"如18-25K","platform":"Boss直聘/猎聘","url":"岗位直达链接","tier":"practice|core|stretch","jd_text":"岗位核心职责与要求摘要(80~150字)"}]\`;
  copyText(prompt);
}

function importMobileCollabRecJson(appendMode = false) {
  const isAppend = Boolean(appendMode && mobileRecList.length);
  const raw = document.getElementById('m-collab-rec-json').value.trim();
  if (!raw) return toast('请先粘贴联网 AI 返回的岗位 JSON 数组');
  const city = document.getElementById('s-city').value.trim() || '上海';
  const kw = document.getElementById('s-kw').value.trim() || '目标岗位';
  const sal = Math.max(5, Number(document.getElementById('s-sal').value) || 18);

  try {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\\[[\\s\\S]*\\]/);
      if (!m) throw new Error('未能解析出 JSON 数组');
      parsed = JSON.parse(m[0]);
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    if (!list.length) throw new Error('JSON 中没有有效岗位');

    const incoming = list
      .filter((x) => x && (x.company || x.title))
      .map((x, idx) => {
        let tier = ['practice', 'core', 'stretch'].includes(x.tier) ? x.tier : '';
        if (!tier) {
          const mid = parseMobileSalaryMid(x.salary);
          if (mid > 0 && mid <= sal * 0.88) tier = 'practice';
          else if ((mid > 0 && mid >= sal * 1.2) || /总监|负责人|专家|VP/i.test(x.title || '')) tier = 'stretch';
          else tier = 'core';
        }
        return {
          id: 'mcollab_' + Date.now() + '_' + idx,
          tier,
          company: String(x.company || '真实企业').trim(),
          title: String(x.title || kw).trim(),
          city: String(x.city || city).trim(),
          salary: String(x.salary || '薪资面议').trim(),
          url: String(x.url || \`https://www.zhipin.com/web/geek/job?query=\${encodeURIComponent(x.title || kw)}\`).trim(),
          match_score: Number(x.match_score) || (tier === 'core' ? 91 : tier === 'practice' ? 88 : 83),
          tier_reason: String(x.tier_reason || '联网导入真实岗位（已自动按薪资与职级归档）').trim(),
          jd_text: String(x.jd_text || \`\${x.company} \${x.title}\`).trim(),
          platform: String(x.platform || '模式B联网导入').trim(),
        };
      });

    if (!isAppend) mobileDismissedKeys.clear();
    mobileRecModeLabel = '模式 B 联网批量导入（真实在招岗位）';
    const added = mergeMobileCandidates(incoming, isAppend);
    renderMobileRecResults();
    toast(isAppend ? \`已追加 \${added} 个真实岗位，当前共 \${mobileRecList.length} 个\` : \`已导入 \${mobileRecList.length} 个真实岗位到三档！\`);
  } catch (e) {
    toast('导入失败：' + e.message);
  }
}

function adoptMobileRecommendedJob(recId) {
  const c = mobileRecList.find((x) => x.id === recId);
  if (!c) return;
  const tpl = detectTemplateClient(c.title, c.jd_text);
  const greetings = buildThreeGreetingsForMobile(c, c.tier);
  const job = {
    id: 'custom_' + Date.now(),
    isCustom: true,
    platform: c.platform || '三档推荐',
    company: c.company,
    title: c.title,
    city: c.city || '上海',
    salary: c.salary || '面议',
    url: c.url || '',
    tier: c.tier || 'core',
    jd_text: c.jd_text || '',
    match_score: c.match_score || 86,
    match_summary: c.tier_reason || '',
    risk_flags: [],
    greetings,
    tailored_resume: null,
    templateId: tpl.id,
    prep: { questions: [], reverse_questions: [], salary_plan: {} },
  };
  state.customJobs.unshift(job);
  saveState();
  renderJobs();
  refreshPrepJobSelect();
  toast(\`已加入「\${MOBILE_TIER_META[c.tier]?.label || '目标岗位'}」并生成 3 套专属话术与适配简历！\`);
  openTailoredResumeModal(job.id);
}

function jumpToTemplate(tplId, tabName) {
  document.getElementById('m-prep-tpl').value = tplId;
  document.getElementById('ms-tpl').value = tplId;
  prepCatFilter = '';
  if (document.getElementById('m-prep-job')) {
    const jobEl = document.getElementById('m-prep-job');
    if ([...jobEl.options].some((o) => o.value === '')) jobEl.value = '';
  }
  renderPrep();
  calcSalary();
  goTab(tabName || 'prep');
  toast('已切换到匹配行业模板！');
}

function jumpToJobPrep(jobId, tplId, tabName) {
  if (tplId) {
    document.getElementById('m-prep-tpl').value = tplId;
    document.getElementById('ms-tpl').value = tplId;
  }
  prepCatFilter = '';
  const jobEl = document.getElementById('m-prep-job');
  if (jobEl && [...jobEl.options].some((o) => String(o.value) === String(jobId))) {
    jobEl.value = String(jobId);
  }
  renderPrep();
  calcSalary();
  goTab(tabName || 'prep');
}

/* ===== 简历底稿保存、预览与按岗位自动生成适配简历 ===== */
function collectResumeForm() {
  const cleanExps = resumeExpList
    .map((e) => ({
      company: String(e.company || '').trim(),
      role: String(e.role || '').trim(),
      period: String(e.period || '').trim(),
      highlights: String(e.highlights || '').trim(),
    }))
    .filter((e) => e.company || e.role || e.highlights);
  const expText = cleanExps
    .map((e) => {
      const head = [e.period, e.company, e.role].filter(Boolean).join(' · ');
      return (head ? head + '：' : '') + e.highlights.replace(/\\r?\\n/g, '；');
    })
    .join('\\n');
  return {
    name: document.getElementById('mr-name').value.trim(),
    contact: document.getElementById('mr-contact').value.trim(),
    basic: document.getElementById('mr-basic').value.trim(),
    stage: document.getElementById('mr-stage').value,
    summary: document.getElementById('mr-summary').value.trim(),
    skills: document.getElementById('mr-skills').value.trim(),
    experiences: cleanExps,
    exp: expText,
    edu: document.getElementById('mr-edu').value.trim(),
  };
}

function saveMobileResume() {
  state.mobileResume = collectResumeForm();
  saveState();
  updateResumeStatusUI();
  toast('我的简历底稿已保存在本机浏览器！');
}

function previewMasterMobileResume() {
  saveMobileResume();
  const dummyJob = {
    id: 'master',
    company: '通用主简历',
    title: state.mobileResume?.basic || '求职简历底稿',
    jd_text: '',
    templateId: detectTemplateClient(state.mobileResume?.basic || '', state.mobileResume?.skills || '').id,
  };
  document.getElementById('rm-modal-title').textContent = '我的简历底稿预览（可打印存 PDF）';
  document.getElementById('rm-modal-body').innerHTML = buildOfflineTailoredResumeHtml(dummyJob);
  document.getElementById('resume-modal').classList.add('open');
}

function saveMobileApi() {
  state.mobileApi = {
    provider: document.getElementById('ma-provider').value,
    apiKey: document.getElementById('ma-key').value.trim(),
  };
  saveState();
  toast(state.mobileApi.apiKey ? '已保存浏览器直连官方 API Key（仅存本机）' : '已清除 API Key，继续使用纯离线模式');
}

function getAllJobs() {
  return [...state.customJobs, ...DATA.jobs];
}

function refreshPrepJobSelect() {
  const all = getAllJobs();
  const wrap = document.getElementById('m-prep-job-wrap');
  const sel = document.getElementById('m-prep-job');
  if (wrap && sel) {
    if (!all.length) {
      wrap.style.display = 'none';
    } else {
      wrap.style.display = 'block';
      sel.innerHTML =
        all.map((j) => \`<option value="\${escAttr(j.id)}">\${esc(j.company)} · \${esc(j.title)} (\${(j.prep?.questions || []).length ? (j.prep.questions.length + '定制题') : '匹配15+行业题'})</option>\`).join('') +
        '<option value="">仅浏览下方 13 大行业全量模板题库</option>';
    }
  }
  if (typeof refreshChatJobSelect === 'function') refreshChatJobSelect();
}

function onPrepJobChange() {
  const val = document.getElementById('m-prep-job').value;
  const job = getAllJobs().find((j) => String(j.id) === String(val));
  if (job?.templateId) {
    document.getElementById('m-prep-tpl').value = job.templateId;
  }
  prepCatFilter = '';
  renderPrep();
}

function onPrepTemplateChange() {
  prepCatFilter = '';
  renderPrep();
}

function setPrepCatFilter(cat) {
  prepCatFilter = cat;
  renderPrep();
}

function toggleAddJob(prefillTitle) {
  const el = document.getElementById('add-job-box');
  if (prefillTitle) {
    switchJobsSubView('search');
    el.style.display = 'block';
    document.getElementById('mj-title').value = prefillTitle;
    onNewJobInput();
    goTab('jobs');
    return;
  }
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function onNewJobInput() {
  const title = document.getElementById('mj-title').value.trim();
  const jd = document.getElementById('mj-jd').value.trim();
  const matched = detectTemplateClient(title, jd);
  document.getElementById('mj-tpl').value = matched.id;
}

function autoFillJobGreeting() {
  const company = document.getElementById('mj-company').value.trim() || '贵司';
  const title = document.getElementById('mj-title').value.trim() || '该岗位';
  const tplId = document.getElementById('mj-tpl').value;
  const tpl = DATA.roleTemplates.find((t) => t.id === tplId) || DATA.roleTemplates[DATA.roleTemplates.length - 1];
  const r = state.mobileResume || {};
  const isFresh = (r.stage || 'mid_career') === 'fresh_grad';
  const firstHighlight = (r.summary || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  const text = isFresh
    ? \`您好！看到\${company}在招「\${title}」，非常感兴趣。我是\${r.basic || '应届毕业生'}，围绕\${tpl.greetingFocus}做过扎实的实习与项目实践\${firstHighlight ? '（' + firstHighlight + '）' : ''}，上手快且熟练用 AI 工具提效。方便发一份针对贵司岗位整理的简历进一步沟通吗？\`
    : \`您好！看到\${company}在招「\${title}」，与我的过往履历高度契合。我具备\${r.basic || '相关实战'}背景，深耕\${tpl.greetingFocus}\${firstHighlight ? '；代表成果：' + firstHighlight : ''}，能快速融入团队拿结果。方便发份定制简历给您评估，进一步沟通下业务细节吗？\`;
  document.getElementById('mj-greet').value = text;
  toast('已根据「' + tpl.name + '」自动生成适配打招呼话术！');
}

function addMobileJob() {
  const company = document.getElementById('mj-company').value.trim();
  const title = document.getElementById('mj-title').value.trim();
  if (!company || !title) return toast('请填写公司名称和岗位名称');
  const jd = document.getElementById('mj-jd').value.trim();
  const tplId = document.getElementById('mj-tpl').value || detectTemplateClient(title, jd).id;
  if (!document.getElementById('mj-greet').value.trim()) autoFillJobGreeting();
  const greet = document.getElementById('mj-greet').value.trim();
  state.customJobs.unshift({
    id: 'm_' + Date.now(),
    platform: '自建岗位',
    company,
    title,
    salary: document.getElementById('mj-salary').value.trim() || '面议',
    city: document.getElementById('mj-city').value.trim(),
    url: document.getElementById('mj-url').value.trim(),
    jd_text: jd,
    templateId: tplId,
    greetings: greet ? [{ style: '智能适配打招呼话术', text: greet }] : [],
    isCustom: true,
  });
  saveState();
  ['mj-company', 'mj-title', 'mj-salary', 'mj-city', 'mj-jd', 'mj-url', 'mj-greet'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('add-job-box').style.display = 'none';
  refreshPrepJobSelect();
  renderJobs();
  toast('岗位已保存，已自动匹配 15+ 题行业题库与适配简历！');
}

function deleteMobileJob(id) {
  state.customJobs = state.customJobs.filter((j) => j.id !== id);
  saveState();
  refreshPrepJobSelect();
  renderJobs();
  toast('已删除');
}

function extractJdKeywords(jdText, tpl) {
  const src = String(jdText || '');
  const found = [];
  for (const kw of (tpl.keywords || [])) {
    if (src.toLowerCase().includes(kw.toLowerCase())) found.push(kw);
  }
  const commonTokens = src.match(/[A-Za-z][A-Za-z0-9+#.-]{1,15}|[\\u4e00-\\u9fa5]{2,6}(?:能力|经验|分析|管理|运营|设计|开发|投放|核算|谈判|增长)/g) || [];
  for (const t of commonTokens) {
    if (!found.includes(t) && found.length < 10) found.push(t);
  }
  return found.slice(0, 8);
}

function buildOfflineTailoredResumeHtml(job) {
  const tpl = DATA.roleTemplates.find((t) => t.id === job.templateId) || detectTemplateClient(job.title, job.jd_text);
  if (job.tailored_resume) {
    const tr = job.tailored_resume;
    return \`
      <div style="font-size:14.5px; line-height:1.65;">
        <div style="border-bottom:2px solid #1e3a8a; padding-bottom:10px; margin-bottom:12px;">
          <div style="font-size:20px; font-weight:800;">\${esc(state.mobileResume?.name || '个人定制简历')}</div>
          <div style="color:#1e40af; font-weight:700; margin-top:2px;">\${esc(tr.headline || job.title)}</div>
          \${tr.basicInfo ? \`<div class="muted">\${esc(tr.basicInfo)}</div>\` : ''}
          \${state.mobileResume?.contact ? \`<div class="muted">\${esc(state.mobileResume.contact)}</div>\` : ''}
        </div>
        \${tr.summary ? \`<h3>个人优势</h3><div class="box">\${esc(tr.summary)}</div>\` : ''}
        \${(tr.experiences || []).length ? \`<h3 style="margin-top:12px;">工作经历</h3>\${tr.experiences.map((e) => \`<div class="box"><strong>\${esc(e.company)} · \${esc(e.role)}</strong> (\${esc(e.period)})\\n\${(e.highlights || []).map((h) => '• ' + esc(h)).join('\\n')}\${(e.subProjects || []).map((sp) => \`\\n【\${esc(sp.name)} · \${esc(sp.role)} | \${esc(sp.period)}】\\n\${(sp.highlights || []).map((h) => '  • ' + esc(h)).join('\\n')}\`).join('')}</div>\`).join('')}\` : ''}
        \${(tr.skills || []).length ? \`<h3 style="margin-top:12px;">核心能力</h3><div class="box">\${tr.skills.map(esc).join('\\n')}</div>\` : ''}
      </div>
    \`;
  }

  const r = state.mobileResume || {};
  const jdKws = extractJdKeywords(job.jd_text, tpl);
  const rawSkills = (r.skills || '').split(/[\\r\\n,，、]+/).map((s) => s.trim()).filter(Boolean);
  const rankedSkills = [...rawSkills].sort((a, b) => {
    const hitA = jdKws.some((k) => a.toLowerCase().includes(k.toLowerCase())) ? 1 : 0;
    const hitB = jdKws.some((k) => b.toLowerCase().includes(k.toLowerCase())) ? 1 : 0;
    return hitB - hitA;
  });
  const summaryLines = (r.summary || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
  const exps = Array.isArray(r.experiences) && r.experiences.length
    ? r.experiences
    : (r.exp ? [{ company: '核心工作与项目经历', role: '', period: '', highlights: r.exp }] : []);

  const expHtml = exps.length
    ? exps.map((e) => {
        const hl = String(e.highlights || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
        return \`<div class="box"><div class="row between"><strong>\${esc(e.company || '项目经历')}\${e.role ? ' · ' + esc(e.role) : ''}</strong>\${e.period ? \`<span class="muted">\${esc(e.period)}</span>\` : ''}</div>\${hl.length ? '\\n' + hl.map((h) => '• ' + esc(h)).join('\\n') : ''}</div>\`;
      }).join('')
    : '<div class="box">（请切换到顶部「我的简历底稿」填写你的工作、实习或项目经历，系统将自动带入排版）</div>';

  return \`
    <div style="font-size:14.5px; line-height:1.65;">
      <div class="no-print box" style="background:#eff6ff; border-color:#bfdbfe; color:#1e3a8a; margin-top:0; margin-bottom:12px;">
        <strong>已按「\${esc(job.company)} · \${esc(job.title)}」智能重排适配</strong>（所属行业：\${esc(tpl.name)}）\\n命中岗位关键词：\${jdKws.length ? jdKws.map(esc).join('、') : '通用岗位重点'}
        \${state.mobileApi?.apiKey && job.id !== 'master' ? \`<div style="margin-top:8px;"><button class="primary sm-btn" onclick="aiTailorResumeOnMobile('\${escAttr(job.id)}')">\${ico('sparkles', 15)}<span>用我配置的官方 API 联网深度改写</span></button></div>\` : '<div class="muted" style="margin-top:4px;">提示：在「谈薪与设置」填入 DeepSeek/Gemini 官方 Key，还可在浏览器直接联网深度改写。</div>'}
      </div>
      <div id="printable-resume" style="border:1px solid #cbd5e1; padding:16px; border-radius:10px; background:#fff;">
        <div style="border-bottom:2px solid #1e3a8a; padding-bottom:10px; margin-bottom:12px;">
          <div style="font-size:20px; font-weight:800;">\${esc(r.name || '求职者（请点击顶部「我的简历底稿」填写称呼）')}</div>
          <div style="color:#1e40af; font-weight:700; margin-top:2px;">求职意向：\${esc(job.title)} · \${esc(tpl.greetingFocus.split('、')[0])}</div>
          \${r.basic ? \`<div class="muted">\${esc(r.basic)}</div>\` : ''}
          \${r.contact ? \`<div class="muted">\${esc(r.contact)}</div>\` : ''}
        </div>
        <h3>个人核心优势</h3>
        <div class="box">\${summaryLines.length ? summaryLines.map((s) => '• ' + esc(s)).join('\\n') : '（请在「我的简历底稿」填入 2~3 条核心优势与量化成果）'}</div>
        <h3 style="margin-top:12px;">核心技能（按本岗相关性置顶）</h3>
        <div class="box">\${rankedSkills.length ? rankedSkills.join(' ｜ ') : esc(tpl.greetingFocus)}</div>
        <h3 style="margin-top:12px;">工作 / 实习与核心经历</h3>
        \${expHtml}
        \${r.edu ? \`<h3 style="margin-top:12px;">教育背景</h3><div class="box">\${esc(r.edu)}</div>\` : ''}
      </div>
    </div>
  \`;
}

function openTailoredResumeModal(jobId) {
  const job = getAllJobs().find((j) => String(j.id) === String(jobId));
  if (!job) return;
  document.getElementById('rm-modal-title').textContent = \`适配简历：\${job.company} · \${job.title}\`;
  document.getElementById('rm-modal-body').innerHTML = buildOfflineTailoredResumeHtml(job);
  document.getElementById('resume-modal').classList.add('open');
}

function closeResumeModal() {
  document.getElementById('resume-modal').classList.remove('open');
}

function printTailoredResume() {
  window.print();
}

async function aiTailorResumeOnMobile(jobId) {
  const job = getAllJobs().find((j) => String(j.id) === String(jobId));
  const apiCfg = state.mobileApi || {};
  if (!job || !apiCfg.apiKey) return toast('请先在「谈薪与设置」填入官方 API Key');
  const r = state.mobileResume || {};
  if (!r.summary && !r.exp) return toast('请先在顶部「我的简历底稿」填入你的真实经历');

  toast('正在直连官方 API 深度改写适配简历...');
  const sys = '你是严谨的中文简历优化专家。严禁虚构经历和数据，仅基于候选人真实底稿针对目标岗位JD重排和润色，直接输出简洁清晰的中文分栏简历纯文本（含求职定位、个人优势3条、核心技能、核心经历润色要点、以及1段160字打招呼话术）。';
  const user = \`目标岗位：\${job.company} - \${job.title} (\${job.salary})\\n岗位JD：\${job.jd_text || '无详细JD'}\\n候选人底稿：\${JSON.stringify({ basic: r.basic, summary: r.summary, skills: r.skills, exp: r.exp, edu: r.edu })}\`;
  try {
    let text = '';
    if (apiCfg.provider === 'gemini') {
      const resp = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=\${encodeURIComponent(apiCfg.apiKey)}\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }] }),
      });
      const d = await resp.json();
      if (!resp.ok) throw new Error(d?.error?.message || 'API 错误');
      text = d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiCfg.apiKey },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      });
      const d = await resp.json();
      if (!resp.ok) throw new Error(d?.error?.message || 'API 错误');
      text = d?.choices?.[0]?.message?.content || '';
    }
    const targetBox = document.getElementById('printable-resume');
    if (targetBox && text) {
      targetBox.innerHTML = \`<div style="white-space:pre-wrap; font-size:14.5px; line-height:1.7;">\${esc(text)}</div>\`;
      toast('AI 适配简历已生成，可点击上方「打印 / 存为 PDF」！');
    }
  } catch (e) {
    toast('调用失败：' + e.message);
  }
}

function renderJobs() {
  const allJobs = getAllJobs();
  const box = document.getElementById('jobs-list');
  if (!allJobs.length) {
    box.innerHTML = '<div class="card muted" style="text-align:center; padding:26px 16px;">还没有保存目标岗位。先点击上方「我的简历底稿」填一次简历，或用「一键全网搜岗位」去 Boss/猎聘找心仪岗位后点「新增目标岗位」，即可自动匹配 15+ 题库与生成适配简历！</div>';
    return;
  }
  box.innerHTML = allJobs.map((j) => {
    const tpl = DATA.roleTemplates.find((t) => t.id === j.templateId) || detectTemplateClient(j.title, j.jd_text);
    const greetingsHtml = (j.greetings || []).map((g, idx) => \`
      <div class="box">
        <div class="row between" style="margin-bottom:6px;">
          <strong style="font-size:14px; color:#1e40af;">话术 \${idx + 1}：\${esc(g.style)}</strong>
          <button class="primary sm-btn" onclick="copyText(this.dataset.t)" data-t="\${escAttr(g.text)}">\${ico('copy', 14)}<span>一键复制</span></button>
        </div>
        <div>\${esc(g.text)}</div>
      </div>
    \`).join('');
    return \`
      <div class="card">
        <div class="row between">
          <strong style="font-size:16.5px;">\${esc(j.company)} · \${esc(j.title)}</strong>
          <div class="row">
            \${j.tier && MOBILE_TIER_META[j.tier] ? \`<span class="pill \${MOBILE_TIER_META[j.tier].color}">\${esc(MOBILE_TIER_META[j.tier].label)}</span>\` : ''}
            \${j.match_score ? \`<span class="pill green">\${j.match_score}分</span>\` : ''}
            \${j.isCustom ? \`<button class="danger sm-btn" onclick="deleteMobileJob('\${escAttr(j.id)}')">\${ico('trash', 14)}<span>删除</span></button>\` : ''}
          </div>
        </div>
        <div class="muted" style="margin-top:4px;">\${esc(j.platform)} ｜ \${esc(j.city)} ｜ \${esc(j.salary)} \${j.url ? \`｜ <a href="\${escAttr(j.url)}" target="_blank">打开原岗位</a>\` : ''}</div>
        <div style="margin-top:8px;"><span class="pill blue">\${ico('sparkles', 13)}<span>智能匹配：\${esc(tpl.name)}（\${(tpl.questions || []).length}题）</span></span></div>
        \${j.match_summary ? \`<div style="margin-top:8px; font-size:14.5px;">\${esc(j.match_summary)}</div>\` : ''}
        \${(j.risk_flags || []).length ? \`<div class="row" style="margin-top:8px;">\${j.risk_flags.map((r) => \`<span class="pill red">\${ico('alert', 13)}<span>\${esc(r)}</span></span>\`).join('')}</div>\` : ''}
        <div class="row" style="margin-top:12px;">
          <button class="primary" style="flex:1;" onclick="openTailoredResumeModal('\${escAttr(j.id)}')">\${ico('fileText', 16)}<span>适配简历</span></button>
          <button style="flex:1;" onclick="jumpToJobPrep('\${escAttr(j.id)}', '\${escAttr(tpl.id)}', 'prep')">\${ico('target', 16)}<span>刷本岗题库</span></button>
          <button onclick="jumpToJobChatReply('\${escAttr(j.id)}')">\${ico('message', 16)}<span>回 HR 消息</span></button>
          <button onclick="jumpToJobPrep('\${escAttr(j.id)}', '\${escAttr(tpl.id)}', 'salary')">\${ico('wallet', 16)}<span>谈薪</span></button>
        </div>
        \${greetingsHtml}
      </div>
    \`;
  }).join('');
}

function toggleAddQ() {
  const el = document.getElementById('add-q-box');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function addMobileQuestion() {
  const q = document.getElementById('mq-q').value.trim();
  const ans = document.getElementById('mq-ans').value.trim();
  if (!q || !ans) return toast('请填写问题和参考答案');
  const tplId = document.getElementById('m-prep-tpl').value;
  if (!state.customQuestions[tplId]) state.customQuestions[tplId] = [];
  state.customQuestions[tplId].unshift({
    category: document.getElementById('mq-cat').value || '核心业务深挖',
    question: q,
    intent: '个人重点演练题',
    framework: document.getElementById('mq-fw').value.trim(),
    answer: ans,
    followUps: [],
    pitfalls: '',
  });
  saveState();
  ['mq-q', 'mq-fw', 'mq-ans'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('add-q-box').style.display = 'none';
  renderPrep();
  toast('已保存到本机题库！');
}

function togglePracticed(key) {
  state.practiced[key] = !state.practiced[key];
  saveState();
  renderPrep();
}

function renderPrep() {
  const jobVal = document.getElementById('m-prep-job')?.value || '';
  const job = jobVal ? getAllJobs().find((j) => String(j.id) === String(jobVal)) : null;
  const tplId = document.getElementById('m-prep-tpl').value;
  const tpl = DATA.roleTemplates.find((t) => t.id === tplId) || DATA.roleTemplates[0];
  const storeKey = job && job.prep?.questions?.length ? 'job_' + job.id : 'tpl_' + tplId;

  const baseQuestions = job?.prep?.questions?.length ? job.prep.questions : (tpl?.questions || []);
  const allQ = [...(state.customQuestions[tplId] || []), ...baseQuestions];
  const done = allQ.filter((q, idx) => state.practiced[storeKey + '_' + idx] || q.practiced).length;
  document.getElementById('m-prep-title').textContent = \`当前题库：共 \${allQ.length} 题（\${done}/\${allQ.length} 已练熟）\`;

  // 渲染分类筛选胶囊
  const catCounts = new Map();
  for (const q of allQ) {
    const c = q.category || '核心业务深挖';
    catCounts.set(c, (catCounts.get(c) || 0) + 1);
  }
  const chipsEl = document.getElementById('m-prep-cat-chips');
  if (chipsEl) {
    chipsEl.innerHTML =
      \`<button class="chip \${!prepCatFilter ? 'active' : ''}" onclick="setPrepCatFilter('')">全部 (\${allQ.length})</button>\` +
      [...catCounts.entries()]
        .map(([c, cnt]) => \`<button class="chip \${prepCatFilter === c ? 'active' : ''}" onclick="setPrepCatFilter('\${escAttr(c)}')">\${esc(c)} (\${cnt})</button>\`)
        .join('');
  }

  const visibleList = allQ
    .map((q, idx) => ({ q, idx }))
    .filter((item) => !prepCatFilter || (item.q.category || '核心业务深挖') === prepCatFilter);

  document.getElementById('m-prep-questions').innerHTML = visibleList.map(({ q, idx }) => {
    const pKey = storeKey + '_' + idx;
    const isDone = Boolean(state.practiced[pKey] || q.practiced);
    return \`
      <div class="card \${isDone ? 'qa-done' : ''}">
        <div class="row between" style="align-items:flex-start;">
          <div style="flex:1; min-width:200px;">
            <span class="pill blue">\${esc(q.category || '高频必考')}</span>
            <div style="font-weight:800; font-size:16px; margin-top:6px; line-height:1.5;">Q\${idx + 1}：\${esc(q.question)}</div>
          </div>
          <button class="sm-btn \${isDone ? 'success' : ''}" onclick="togglePracticed('\${escAttr(pKey)}')">\${ico(isDone ? 'checkCircle' : 'circle', 15)}<span>\${isDone ? '已练熟' : '打卡'}</span></button>
        </div>
        <details style="margin-top:10px;">
          <summary class="sum-link">\${ico('sparkles', 15)}<span>展开答题框架、高分长答案与连环追问</span></summary>
          \${q.intent ? \`<div class="muted" style="margin-top:8px;"><strong>考察意图：</strong>\${esc(q.intent)}</div>\` : ''}
          \${q.framework ? \`<div class="box" style="background:#eff6ff; border-color:#bfdbfe; color:#1e3a8a;"><strong>答题框架：</strong>\${esc(q.framework)}</div>\` : ''}
          <div class="box" style="border-left:3.5px solid #2563eb;">\${esc(q.answer)}</div>
          \${(q.followUps || []).length ? \`<div class="box" style="background:#fffbeb; border-color:#fde68a;"><strong style="color:#b45309; display:inline-flex; align-items:center; gap:5px;">\${ico('zap', 15)}<span>面试官连环追问：</span></strong>\\n\${q.followUps.map((f) => '• ' + esc(f)).join('\\n')}</div>\` : ''}
          \${q.pitfalls ? \`<div style="margin-top:8px; font-size:14px; font-weight:600; color:#b91c1c; display:flex; align-items:flex-start; gap:6px;">\${ico('alert', 16)}<span><strong>踩坑预警：</strong>\${esc(q.pitfalls)}</span></div>\` : ''}
        </details>
      </div>
    \`;
  }).join('');

  const checklist = DATA.reverseChecklistsByTemplate[tplId] || DATA.universalReverseChecklist;
  const customRev = job?.prep?.reverse_questions || [];
  const customHtml = customRev.length
    ? \`<details open style="margin-bottom:10px;"><summary style="font-weight:800; color:#059669; display:flex; align-items:center; gap:6px;">\${ico('star', 16)}<span>本岗位专属定制反问</span></summary>\${customRev.map((r) => \`<div class="box"><div class="row between"><strong>\${esc(r.question)}</strong><button class="sm-btn" onclick="copyText(this.dataset.t)" data-t="\${escAttr(r.question)}">\${ico('copy', 14)}<span>复制</span></button></div><div class="muted" style="margin-top:4px;">\${esc(r.purpose)}</div></div>\`).join('')}</details>\`
    : '';
  document.getElementById('m-reverse-checklist').innerHTML = customHtml + checklist.map((g) => \`
    <details style="margin-bottom:10px; border-top:1px solid #e2e8f0; padding-top:8px;">
      <summary style="font-weight:700; color:#1e3a8a; font-size:15px;">\${esc(g.dimension)}</summary>
      \${(g.items || []).map((it) => \`<div class="box"><div class="row between"><strong>• \${esc(it.question)}</strong><button class="sm-btn" onclick="copyText(this.dataset.t)" data-t="\${escAttr(it.question)}">\${ico('copy', 14)}<span>复制</span></button></div><div class="muted" style="margin-top:4px;">\${esc(it.purpose)}</div></div>\`).join('')}
    </details>
  \`).join('');
}

function refreshChatJobSelect() {
  const sel = document.getElementById('m-chat-job');
  if (!sel) return;
  const prev = sel.value;
  const all = getAllJobs();
  sel.innerHTML =
    '<option value="">不绑定具体岗位（通用回复）</option>' +
    all.map((j) => \`<option value="\${escAttr(j.id)}">\${esc(j.company)} · \${esc(j.title)}（\${esc(j.salary || '面议')}）</option>\`).join('');
  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  } else if (all.length && !prev) {
    sel.value = String(all[0].id);
  }
}

function jumpToJobChatReply(jobId) {
  refreshChatJobSelect();
  const sel = document.getElementById('m-chat-job');
  if (sel && [...sel.options].some((o) => o.value === String(jobId))) {
    sel.value = String(jobId);
  }
  goTab('chat');
  const inp = document.getElementById('m-chat-hr-msg');
  if (inp) inp.focus();
  onMobileChatContextChange();
  toast('已切换到该岗位！粘贴 HR 发来的消息点生成即可');
}

function detectMobileChatScenario(hrMsg, selectedScene) {
  if (selectedScene && selectedScene !== '自动识别') return selectedScene;
  const msg = String(hrMsg || '').trim();
  if (!msg) return '薪资试探与报价';
  if (/大小周|双休|单休|加班|作息|五险一金|几点下班|工时/.test(msg)) return '核实双休与福利';
  if (/打折|打八折|试用期|降薪|预算有限|压薪|给不到|底薪.*低|高提成|高绩效|浮动/.test(msg)) return '应对压薪或试用期打折';
  if (/期望.*薪|薪资|报价|多少[kK千]|月薪|年薪|税前|目前薪|上家薪/.test(msg)) return '薪资试探与报价';
  if (/空窗|离职|为什么离开|为什么走|这段时间|没工作|gap|待业/.test(msg)) return '回应空窗期或离职原因';
  if (/学历|大专|专科|本科|跨行|类目|行业|没做过|经验匹配/.test(msg)) return '回应学历或跨类目追问';
  if (/约.*面|面试|方便聊|发.*简历|微信|电话|什么时候到岗|合适吗/.test(msg)) return '推进约面或体面婉拒';
  return '薪资试探与报价';
}

function extractMobileResumeSnippet() {
  const r = state.mobileResume || {};
  const sumFirst = String(r.summary || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  const expFirst = Array.isArray(r.experiences) && r.experiences.length
    ? String(r.experiences[0]?.highlights || '').split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean)[0] || ''
    : '';
  const raw = sumFirst || expFirst || String(r.exp || '').split(/\\r?\\n/)[0] || '';
  const highlight = String(raw).replace(/^[•·\\-*\\d.、\\s]+/, '').trim().slice(0, 65);
  const skillsTop = String(r.skills || '').split(/[\\r\\n,，、]+/).map((s) => s.trim()).filter(Boolean).slice(0, 4).join('、');
  return {
    basic: String(r.basic || '').trim(),
    highlight,
    skillsTop,
    hasResume: Boolean(highlight || r.basic || skillsTop),
  };
}

function buildLocalMobileChatReplies(job, resolvedScene, hrMsg, snippet, salTarget) {
  const company = job?.company || '贵司';
  const title = job?.title || '目标岗位';
  const salaryText = job?.salary && job.salary !== '面议' ? job.salary : (salTarget ? \`\${salTarget}K 左右\` : '目标区间');
  const expPhrase = snippet.highlight ? \`我过往实战做到：\${snippet.highlight}\` : '结合我过往核心项目操盘与一线拿结果经验';
  const basicBracket = snippet.basic ? \`（\${snippet.basic}）\` : '';

  const analysisMap = {
    核实双休与福利: '核心诉求：礼貌而清晰地问清周末双休、五险一金与底薪/绩效结构，避免白跑一趟。',
    薪资试探与报价: '核心策略：给出略高于目标的锚定区间，同时反问岗位定薪范围与绩效口径，不盲目报低价。',
    应对压薪或试用期打折: '核心策略：先用过往量化成果锚定即战力价值，守住固定底薪底线或争取缩短试用期。',
    回应空窗期或离职原因: '核心策略：不抱怨前司，把空窗期定位为系统复盘与精挑同频赛道，消除稳定性顾虑。',
    回应学历或跨类目追问: '核心策略：不陷入自证焦虑，直接用可迁移的真实结果与方法论争取面试展示机会。',
    推进约面或体面婉拒: '核心策略：若匹配则立刻锁定 2 个具体面试时间窗口；若作息/薪资明显不合则礼貌止损。',
  };

  if (!snippet.hasResume && !hrMsg && DATA.quickChatBank?.[resolvedScene]) {
    return { analysis: analysisMap[resolvedScene] || '', replies: DATA.quickChatBank[resolvedScene] };
  }

  const personalizedMap = {
    核实双休与福利: [
      {
        style: '礼貌自然确认型',
        text: \`您好，感谢回复！我对 \${company}「\${title}」很感兴趣\${basicBracket}，\${expPhrase}。想提前跟您确认两个基础信息方便高效推进：一是咱们团队平时作息是周末双休吗？二是薪资结构大概是纯底薪还是底薪+绩效呢？\`,
      },
      {
        style: '业务切入顺带核实型',
        text: \`收到，谢谢您的介绍！岗位职责和我的经历很契合（\${expPhrase}），也很看好咱们业务。方便顺便了解下团队上班时间（是否周末双休）以及五险一金缴纳情况吗？合适的话我随时方便约聊。\`,
      },
      {
        style: '直爽高效筛选型',
        text: \`您好！为了不耽误双方时间，先跟您确认下这个岗位是明确周末双休的吗？我比较看重长期稳定高效的节奏，\${expPhrase}，如果作息和业务方向一致，咱们可以约个时间细聊。\`,
      },
    ],
    薪资试探与报价: [
      {
        style: '先问预算锚定型（推荐）',
        text: \`您好！薪资我更看重权责与匹配度，\${expPhrase}。参考行业水平和我的实战体量，期望大致在贵司标薪（\${salaryText}）的中高档位。方便先了解下咱们这个岗位具体的定薪区间和绩效结构吗？\`,
      },
      {
        style: '价值锚定报价型',
        text: \`您好！\${expPhrase}\${basicBracket}，我希望整体月薪能落在一个匹配业务产出的合理区间（参考 \${salaryText}），具体可以结合考核指标和年终月数综合沟通，互相认可都好谈。\`,
      },
      {
        style: '反客为主约面型',
        text: \`您好！薪资方面我有大概心理区间，不过更希望能先跟业务负责人深入聊下团队接下来的目标和挑战（\${expPhrase}），确认人岗高度契合后再按公司定级来谈会更准确，您看先约个面试方便吗？\`,
      },
    ],
    应对压薪或试用期打折: [
      {
        style: '底薪保底换绩效型',
        text: \`理解公司对人效和成本的考量。\${expPhrase}，我很愿意拿结果说话，不过固定底薪希望尽量靠近我的目标线；如果预算紧张，可以把浮动激励放在季度/节点超额达成奖金上，我帮团队做出增量，大家双赢。\`,
      },
      {
        style: '试用期全薪争取型',
        text: \`关于试用期，我属于能直接上手扛指标的即战力（\${expPhrase}），能帮团队省掉不少试错成本。通常成熟岗试用期可申请全薪，或者咱们约定 1~2 个月清晰转正考核目标，达标即提前转正您看行吗？\`,
      },
      {
        style: '坚守底线礼貌拉回型',
        text: \`感谢您的坦诚沟通，我也很认可团队方向。不过这个数字离我的底线略有差距，基于我过往的实战产出（\${expPhrase}），如果固定薪资能再往上靠一靠，或在半年调薪机制上书面明确，我非常有诚意推进后续。\`,
      },
    ],
    回应空窗期或离职原因: [
      {
        style: '主动复盘蓄力型（推荐）',
        text: \`上一阶段高强度负责核心业务后（\${expPhrase}），离开后我主动给自己留了一段休整期做系统复盘，把方法论、数据拆解和协作流程彻底梳理沉淀了一遍。现在状态很饱满，希望找一家重视长期价值的团队稳定深耕。\`,
      },
      {
        style: '方向升级聚焦型',
        text: \`之前在原岗位积累了扎实的一线实战与拿结果经验（\${expPhrase}）；调整复盘后我更清楚下一阶段想聚焦在更贴合自身优势的赛道里把业务做深做透，所以这段时间也在精挑真正同频的团队。\`,
      },
      {
        style: '简短坦诚发简历型',
        text: \`前一段项目收尾后做了短暂的个人调整和复盘，目前随时可以到岗。我对 \${company}「\${title}」的方向很看好，\${expPhrase}，方便先发份针对贵司的适配简历给您看下吗？\`,
      },
    ],
    回应学历或跨类目追问: [
      {
        style: '硬核实战破格型（推荐）',
        text: \`确实，我在学历/背景上不是传统最标准的履历，这点很坦诚。但咱们这个岗位归根结底看实战拿结果能力——\${expPhrase}，这些实打实的操盘壁垒与避坑经验能帮团队立刻省下试错成本，恳请给一次面试机会让我用具体复盘证明。\`,
      },
      {
        style: '方法论迁移型',
        text: \`虽然细分行业/类目略有不同，但底层的「用户需求洞察、漏斗数据归因、项目推进与转化提效」逻辑高度相通。\${expPhrase}，把这套成熟打法迁移到贵司赛道上手会很快，我也提前研究了贵司产品，期待细聊。\`,
      },
      {
        style: '先发定制简历验证型',
        text: \`非常理解贵司的用人标准\${basicBracket}。其实过往几段核心项目都是真刀真枪做出来的，\${expPhrase}。我已经结合贵司岗位要求整理了一份针对性简历，方便先发您看 1 分钟再决定是否约聊吗？\`,
      },
    ],
    推进约面或体面婉拒: [
      {
        style: '积极锁约面时间型（推荐）',
        text: \`好的，非常期待进一步交流！\${expPhrase}，对贵司「\${title}」非常看好。我这边明天上午 10:00 后或下午 14:00-17:00 都方便，线上或线下都可以，您看哪个时间段用人部门方便？\`,
      },
      {
        style: '先发定制简历约面型',
        text: \`收到，没问题！我已针对 \${company}「\${title}」整理好了适配简历（重点突出了：\${snippet.highlight || '核心项目业绩与复盘数据'}），这就发您。您和用人负责人看完后，我随时配合沟通时间。\`,
      },
      {
        style: '高情商体面婉拒型',
        text: \`非常感谢您的时间和详细介绍！综合评估了下，目前这个岗位在作息/业务定位上与我现阶段的规划略有差异，为了不耽误贵司的招聘进度，这次就先不打扰了。祝团队早日找到合适人选，希望以后还有交流机会！\`,
      },
    ],
  };

  return {
    analysis: analysisMap[resolvedScene] || '',
    replies: personalizedMap[resolvedScene] || personalizedMap['薪资试探与报价'],
  };
}

function renderMobileChatOutput(analysisText, replies, detectedScene, usedResume) {
  const anaEl = document.getElementById('m-chat-analysis');
  if (anaEl) {
    if (analysisText || detectedScene) {
      anaEl.style.display = 'block';
      anaEl.innerHTML =
        \`<div class="row between" style="margin-bottom:4px;"><strong>识别场景：\${esc(detectedScene)}</strong>\${usedResume ? '<span class="pill green">已结合我的简历底稿</span>' : '<span class="pill">通用模板（填简历后自动融入个人战绩）</span>'}</div>\` +
        (analysisText ? \`<div style="font-size:14px;">\${esc(analysisText)}</div>\` : '');
    } else {
      anaEl.style.display = 'none';
    }
  }
  document.getElementById('m-chat-replies').innerHTML = (replies || []).map((r, i) => \`
    <div class="card">
      <div class="row between" style="margin-bottom:8px;">
        <strong style="font-size:15.5px;">方案 \${i + 1}：\${esc(r.style)}</strong>
        <button class="primary sm-btn" onclick="copyText(this.dataset.t)" data-t="\${escAttr(r.text)}">\${ico('copy', 14)}<span>一键复制</span></button>
      </div>
      <div style="white-space:pre-wrap; font-size:15.5px; line-height:1.7;">\${esc(r.text)}</div>
    </div>
  \`).join('');
}

function onMobileChatContextChange() {
  generateMobileSmartChatReply(false);
}

function renderChatBank() {
  generateMobileSmartChatReply(false);
}

async function generateMobileSmartChatReply(useApi = false) {
  const jobId = document.getElementById('m-chat-job')?.value || '';
  const job = jobId ? getAllJobs().find((j) => String(j.id) === String(jobId)) : null;
  const selectedScene = document.getElementById('m-chat-scene')?.value || '自动识别';
  const hrMsg = document.getElementById('m-chat-hr-msg')?.value.trim() || '';
  const salTarget = document.getElementById('ms-target')?.value || document.getElementById('s-sal')?.value || '';
  const snippet = extractMobileResumeSnippet();
  const resolvedScene = detectMobileChatScenario(hrMsg, selectedScene);

  if (useApi) {
    const apiCfg = state.mobileApi || {};
    if (!apiCfg.apiKey) {
      toast('未配置 API Key，已改用你的简历底稿 0 秒本地生成');
    } else if (!hrMsg) {
      toast('用 AI 深度定制请先粘贴 HR 发来的原话，先为你展示本地建议');
    } else {
      const btn = document.getElementById('btn-m-chat-ai');
      if (btn) btn.disabled = true;
      toast('正在结合你的简历底稿与 HR 原话生成高情商回复...');
      try {
        const sys = '你是高情商、懂谈薪与博弈心理的求职沟通顾问。必须严格忠实于候选人提供的真实简历，严禁虚构经历与数据。请只输出合法纯 JSON 对象：{"analysis":"一句话点破HR意图(50字内)","replies":[{"style":"稳重专业型","text":"直接可复制的回复(60~150字)"},{"style":"高情商推进/反问型","text":"直接可复制的回复"},{"style":"坚守底线型","text":"直接可复制的回复"}]}';
        const user = \`目标岗位：\${job ? job.company + ' - ' + job.title + ' (' + (job.salary || '面议') + ')' : '未指定具体岗位'}\\n识别场景：\${resolvedScene}\\n期望月薪参考：\${salTarget || '未指定'}K\\nHR原话：\${hrMsg}\\n候选人简历信息：\${JSON.stringify({ basic: snippet.basic, highlight: snippet.highlight, skills: snippet.skillsTop })}\`;
        let rawText = '';
        if (apiCfg.provider === 'gemini') {
          const resp = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=\${encodeURIComponent(apiCfg.apiKey)}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.4 } }),
          });
          const d = await resp.json();
          if (!resp.ok) throw new Error(d?.error?.message || 'API 错误');
          rawText = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\\n');
        } else {
          const resp = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiCfg.apiKey },
            body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.4 }),
          });
          const d = await resp.json();
          if (!resp.ok) throw new Error(d?.error?.message || 'API 错误');
          rawText = d?.choices?.[0]?.message?.content || '';
        }
        const m = rawText.match(/\\{[\\s\\S]*\\}/);
        if (m) {
          const parsed = JSON.parse(m[0]);
          if (Array.isArray(parsed?.replies) && parsed.replies.length) {
            renderMobileChatOutput(parsed.analysis || '', parsed.replies, resolvedScene, snippet.hasResume);
            if (btn) btn.disabled = false;
            toast('AI 结合简历定制回复已就绪！');
            return;
          }
        }
      } catch (e) {
        toast('AI 调用异常（' + e.message + '），已自动切换本地生成');
      } finally {
        if (btn) btn.disabled = false;
      }
    }
  }

  const localRes = buildLocalMobileChatReplies(job, resolvedScene, hrMsg, snippet, salTarget);
  renderMobileChatOutput(localRes.analysis, localRes.replies, resolvedScene, snippet.hasResume);
}

function copyMobileChatCollabPrompt() {
  const jobId = document.getElementById('m-chat-job')?.value || '';
  const job = jobId ? getAllJobs().find((j) => String(j.id) === String(jobId)) : null;
  const hrMsg = document.getElementById('m-chat-hr-msg')?.value.trim() || '（请在这里补充 HR 发来的原话）';
  const snippet = extractMobileResumeSnippet();
  const prompt = \`请扮演高情商求职沟通顾问，结合我的背景与目标岗位，帮我针对用人单位的回复拟定 3 套不同风格、可直接复制发在招聘软件上的高情商回复（每套 60~140 字，自然口语化、守住双休与合理薪资底线，不虚构经历）：\\n【目标岗位】\${job ? job.company + ' · ' + job.title + '（' + (job.salary || '面议') + '）' : '通用岗位'}\\n【我的脱敏背景】\${[snippet.basic, snippet.highlight, snippet.skillsTop].filter(Boolean).join(' ｜ ') || '请结合资深实战能力自然发挥'}\\n【用人单位原话】\${hrMsg}\`;
  copyText(prompt);
}

function calcSalary() {
  const target = Number(document.getElementById('ms-target').value) || 15;
  const floor = Number(document.getElementById('ms-floor').value) || 12;
  const months = Number(document.getElementById('ms-months').value) || 13;
  const perf = Math.min(60, Math.max(0, Number(document.getElementById('ms-perf').value) || 0));
  const anchor = Math.max(target + 2, Math.round(target * 1.15));
  const guaranteed = (target * (100 - perf) / 100).toFixed(1);
  const annT = ((target * months) / 10).toFixed(1);
  const annA = ((anchor * months) / 10).toFixed(1);
  const annF = ((floor * months) / 10).toFixed(1);

  document.getElementById('ms-kpis').innerHTML = \`
    <div class="kpi"><div class="muted">建议开价锚点</div><div class="v">\${anchor}K/月</div><div class="muted">约 \${annA}万/年</div></div>
    <div class="kpi"><div class="muted">核心目标月薪</div><div class="v">\${target}K/月</div><div class="muted">约 \${annT}万/年</div></div>
    <div class="kpi"><div class="muted">撤退底线</div><div class="v" style="color:#d97706;">\${floor}K/月</div><div class="muted">约 \${annF}万/年</div></div>
    <div class="kpi"><div class="muted">扣\${perf}%绩效保底</div><div class="v" style="color:#059669;">\${guaranteed}K/月</div><div class="muted">固定底薪底线</div></div>
  \`;

  const tplId = document.getElementById('ms-tpl').value;
  const tpl = DATA.roleTemplates.find((t) => t.id === tplId) || DATA.roleTemplates[0];
  const ss = tpl.salaryStructure;
  document.getElementById('ms-role-tip').innerHTML = \`<strong>「\${esc(tpl.name)}」典型薪资结构：</strong>\${esc(ss.typical)}\\n\${(ss.keyChecks || []).map((c) => '• ' + esc(c)).join('\\n')}\`;

  const dynamicPlaybooks = [
    {
      title: '1. HR 一上来就问：“你期望薪资多少？”',
      tactic: '给出略高于目标价的紧凑区间，同时顺手探明对方定薪结构。',
      script: \`“结合岗位权责和我的过往经验，如果按 \${months} 薪结构算，我期望月薪在 \${target}K - \${anchor}K（年包约 \${annT}万 - \${annA}万）。也想先了解下咱们这个岗位的定薪区间和绩效结构？”\`,
    },
    {
      title: '2. HR 压价：“你期望超预算了，只能给到较低数字”',
      tactic: '守住底线，拆解成“固定靠近目标 + 业绩超额奖/半年调薪”。',
      script: \`“理解预算考量。固定月薪希望能尽量往 \${Math.max(floor, target - 1)}K 靠（不低于底线 \${floor}K），差额部分我们可以放到季度超额达成奖金或入职半年调薪复核里，我用明确产出换增量。”\`,
    },
    {
      title: '3. HR 说：“我们底薪低一点，但提成/绩效非常丰厚”',
      tactic: '算清扣除绩效后的真实保底，并追问历史平均达成率与提成口径。',
      script: \`“我非常愿意拿结果说话。为了准确评估，方便告知固定保底占比（按 \${perf}% 绩效算保底约 \${guaranteed}K）以及团队过去几个季度的平均绩效达成率、提成是按净成交还是毛利算吗？”\`,
    },
    {
      title: '4. HR 说：“试用期 3 个月，薪资打八折”',
      tactic: '优先争取全薪，次优争取缩短试用期或书面约定提前转正条件。',
      script: \`“我属于能快速上手产出的候选人，咱们能申请试用期全薪吗？如果制度卡得严，能否约定 1~2 个月达到明确考核目标即提前转正？”\`,
    },
    {
      title: '5. HR 拿学历/空窗期/应届身份压价',
      tactic: '不自我贬低，把话题拉回“能帮团队省多少试错成本、多快产生确定性产出”。',
      script: \`“换工作我更看重岗位本身的市场价值和我能带来的真实产出。我已经针对贵司业务做了系统梳理和方案准备，入职后能快速进入状态交付结果，综合人效其实更有优势。”\`,
    },
    {
      title: '6. 拿口头 Offer 前必核对的 5 项落纸条款',
      tactic: '口头答应不算数，正式发 Offer 邮件前把关键项逐条确认。',
      script: \`“非常期待加入！发正式 Offer 邮件时麻烦帮忙写明：① 税前月薪（底薪+绩效拆分）与试用期薪资；② 发放月数及年终奖口径；③ 明确周末双休作息；④ 五险一金缴纳基数和比例；⑤ 入职日期与汇报线。”\`,
    },
  ];

  document.getElementById('ms-playbooks').innerHTML = dynamicPlaybooks.map((pb) => \`
    <details style="border-top:1px solid #e2e8f0; padding:10px 0;">
      <summary style="font-weight:700; font-size:15px;">\${esc(pb.title)}</summary>
      <div class="muted" style="margin-top:6px;">心法：\${esc(pb.tactic)}</div>
      <div class="box">\${esc(pb.script)}</div>
      <button class="sm-btn" style="margin-top:8px;" onclick="copyText(this.dataset.t)" data-t="\${escAttr(pb.script)}">\${ico('copy', 14)}<span>复制话术</span></button>
    </details>
  \`).join('');

  document.getElementById('ms-traps').innerHTML = DATA.universalSalaryTraps.map((t) => \`<li style="margin-bottom:6px;">\${esc(t)}</li>\`).join('');
}

function generateMobileCareerPlan() {
  const planType = document.getElementById('mc-type').value;
  const stageId = document.getElementById('mc-stage').value;
  const role = document.getElementById('mc-role').value.trim();
  const skillsRaw = document.getElementById('mc-skills').value.trim();
  const stage = DATA.careerStages.find((s) => s.id === stageId) || DATA.careerStages[1];
  const matched = detectTemplateClient(role, skillsRaw);
  const isFresh = stageId === 'fresh_grad';

  const directions = planType === 'explore'
    ? [
        {
          track: '稳妥深耕线（最高匹配）',
          direction: \`\${matched.name}\`,
          tplId: matched.id,
          target_titles: role ? [role, matched.name.split(' / ')[0]] : [matched.name.split(' / ')[0], matched.name.split(' / ')[1] || '相关专员/主管'],
          salary_range: isFresh ? '8K - 15K' : '15K - 28K',
          why_fit: \`与你填写的背景和方向匹配度最高，核心聚焦：\${matched.greetingFocus}。\`,
          first_step: '点击下方推荐岗位直接去招聘平台搜真岗位，并先刷完该行业内置 15+ 道深度题库。',
        },
        {
          track: 'AI 提效赋能线（高成长红利）',
          direction: 'AI 大模型应用 / AIGC 业务提效 / AI 产品与项目岗',
          tplId: 'ai_role',
          target_titles: ['AI 应用专员/经理', 'AI 产品经理', 'AIGC 运营'],
          salary_range: isFresh ? '10K - 18K' : '18K - 35K',
          why_fit: '当下全行业都在抢“懂本行业务 + 会用 AI 降本增效”的复合人选，跨行溢价极高。',
          first_step: '把自己熟悉领域最耗时的 1 个任务用 AI 跑通自动化工作流，整理成 1 页可演示作品。',
        },
        {
          track: '跨界跃迁线',
          direction: isFresh ? '高成长行业综合运营 / 商业分析 / 管培生' : '从执行岗跃迁为项目负责人(PM)或跨界高毛利赛道骨干',
          tplId: isFresh ? 'new_media_ops' : 'product_ops',
          target_titles: isFresh ? ['管培生', '内容运营', '数据分析助理'] : ['项目经理(PM)', '业务负责人', '商业分析经理'],
          salary_range: isFresh ? '9K - 16K' : '20K - 35K+',
          why_fit: '把底层通用的数据分析、拆解推进和沟通能力迁移到上升期赛道。',
          first_step: '拆解目标赛道 3 家标杆公司公开案例，写 1 份 2 页行业诊断文档带去面试。',
        },
      ]
    : [
        {
          track: '目标岗位聚焦',
          direction: role || matched.name,
          tplId: matched.id,
          target_titles: [role || matched.name.split(' / ')[0]],
          salary_range: isFresh ? '8K - 16K' : '15K - 30K',
          why_fit: \`已为你自动匹配「\${matched.name}」知识库，聚焦核心能力：\${matched.greetingFocus}。\`,
          first_step: '先攻克下方 P0 技能缺口产出 1 份实战作品，再点下方按钮一键搜岗位和刷题。',
        },
      ];

  const gaps = isFresh
    ? [
        { priority: 'P0', skill: '结构化作品集与 STAR 案例包装', why_needed: '应届生无全职履历，一份扎实的作品集/竞品分析报告能直接击败 80% 竞争者。', practice_method: '选 1 个校园/实习项目或挑 1 家心仪公司写份体验诊断，按“痛点→调研→动作→结果”排版。', deliverable: '3~5 页 PDF 求职作品集 / 目标公司分析报告' },
        { priority: 'P0', skill: \`「\${matched.name.split(' / ')[0]}」核心实操与 AI 提效\`, why_needed: '现代岗位默认要求具备核心业务拆解能力并善用 AI 工具提效。', practice_method: \`对照「\${matched.name}」高频考点，用 1 周完成 1 个真实小案例演练，并用 AI 记录提效前后对比。\`, deliverable: '1 份岗位实战小作品 + 1 个 AI 提效演示案例' },
        { priority: 'P1', skill: '高频面试问答与防坑核验', why_needed: '避免面试紧张流水账，同时避开培训贷、无薪试岗和霸王条款。', practice_method: '切到「面试题库」选应届生模板和目标行业模板刷完 15 道题，手机录音自测 3 遍。', deliverable: '个人高频 15 问口语逐字稿 + 6 维反问清单' },
      ]
    : [
        { priority: 'P0', skill: '经营结果账与结构化数据归因', why_needed: '高薪骨干与普通执行最大的分水岭是“懂 ROI、懂成本收益、能快速定位漏斗卡点”。', practice_method: '拿自己过往 1 个核心项目重做一份包含成本拆解、转化漏斗、异常诊断与优化结论的一页纸复盘。', deliverable: '脱敏版《核心项目复盘与增长方法论（1~2页）》' },
        { priority: 'P0', skill: 'AI 工具融入本职工作流（复合竞争力）', why_needed: '能用 AI 把团队调研、文档、脚本或代码产出提效 2~3 倍的候选人议价权显著更高。', practice_method: '挑日常最重复耗时的 2 个环节，沉淀固定 Prompt 模板与验收标准并测算提效幅度。', deliverable: '2 个可直接讲给面试官听的“AI 降本增效实战案例”' },
        { priority: 'P1', skill: '跨部门推进与向上管理故事库', why_needed: '中高级岗位二面/终面高频考察资源博弈、冲突化解与拿结果韧性。', practice_method: '复盘 2 次真实资源紧张或意见分歧经历，按“对齐共同目标→拿数据说话→小步验证”打磨成 STAR 故事。', deliverable: '2 个高分跨部门协作与压力追问案例' },
      ];

  state.customCareerPlan = {
    headline: \`\${role || matched.name} · 职业规划与技能提升方案\`,
    positioning_summary: \`\${stage.summary}\${skillsRaw ? ' 你当前已有基础：' + skillsRaw + '。' : ''} 已为你智能匹配「\${matched.name}」及相关跃迁方向，点击下方推荐岗位可直接一键搜真岗位或刷 15+ 深度题库！\`,
    recommended_directions: directions,
    skill_gaps: gaps,
    roadmap: [
      { phase: '第 1 周：定位校准与核心资产打磨', goal: '完善底稿简历与 1 份可展示的复盘/作品集', actions: ['明确主攻岗位边界与双休/薪资底线', '产出 1 份 P0 技能对应的实战拆解文档', '在「面试题库」刷完对应行业 15+ 核心题与连环追问'] },
      { phase: '第 2~3 周：练手面试与短板迭代', goal: '先面中腰部岗位热身，每场面试后当天复盘补漏', actions: ['在工作日 09:30-11:00 黄金窗分批投递', '每场真实面试后记录被问倒的问题并补写参考答案', '对照 6 维反问清单核实团队现状、薪资口径与双休'] },
      { phase: '第 4 周：冲刺理想目标与谈薪签约', goal: '手握保底筹码冲刺高薪机会，体面谈薪落纸 Offer', actions: ['用「谈薪博弈」定好开价锚点、目标价与撤退底线', '核实五险一金基数、试用期全薪与年终口径后稳健签约'] },
    ],
  };
  saveState();
  renderCareer();
  toast('已为你智能匹配推荐方向与技能练习清单！');
}

function searchRecommendedTitle(title) {
  switchJobsSubView('search');
  document.getElementById('s-kw').value = title;
  updateSearchLinks();
  goTab('jobs');
  toast('已填入「' + title + '」，点上方平台按钮即可直达搜岗！');
}

function toggleCareer(key) {
  state.careerDone[key] = !state.careerDone[key];
  saveState();
  renderCareer();
}

function renderCareer() {
  const box = document.getElementById('m-career-body');
  const p = state.customCareerPlan || DATA.careerPlans?.[0]?.plan || null;
  if (!p) {
    box.innerHTML = '<div class="card muted" style="text-align:center; padding:24px;">在上方选择你的阶段并填写目标方向或已有技能，点「0 秒智能匹配推荐岗位与技能练习方案」立刻开始！</div>';
    return;
  }
  box.innerHTML = \`
    <div class="card" style="background:#f8fbff; border-color:#bfdbfe;">
      <h2>\${esc(p.headline || '职业规划')}</h2>
      <div style="white-space:pre-wrap;">\${esc(p.positioning_summary || '')}</div>
    </div>
    \${(p.recommended_directions || []).map((d) => \`
      <div class="card">
        <div class="row between"><span class="pill blue">\${esc(d.track)}</span><strong style="color:#059669; font-size:16px;">\${esc(d.salary_range)}</strong></div>
        <div style="font-weight:800; font-size:16px; margin:8px 0 6px;">\${esc(d.direction)}</div>
        <div style="margin-top:4px;"><strong>适合原因：</strong>\${esc(d.why_fit)}</div>
        <div style="margin-top:6px; color:#1d4ed8;"><strong>第一步：</strong>\${esc(d.first_step)}</div>
        \${(d.target_titles || []).length ? \`<div class="row" style="margin-top:10px;">\${d.target_titles.map((t) => \`<button class="sm-btn" onclick="searchRecommendedTitle('\${escAttr(t)}')">\${ico('search', 14)}<span>去搜：\${esc(t)}</span></button>\`).join('')}\${d.tplId ? \`<button class="primary sm-btn" onclick="jumpToTemplate('\${escAttr(d.tplId)}', 'prep')">\${ico('target', 14)}<span>刷题</span></button>\` : ''}</div>\` : ''}
      </div>
    \`).join('')}
    <div class="card">
      <h3>\${ico('zap', 17)}<span>技能缺口 & 可练习补强方案</span></h3>
      \${(p.skill_gaps || []).map((g, i) => {
        const k = 'gap_' + i;
        const done = Boolean(state.careerDone[k] || g.done);
        return \`
          <div class="box \${done ? 'qa-done' : ''}">
            <div class="row between">
              <strong>[\${esc(g.priority)}] \${esc(g.skill)}</strong>
              <button class="sm-btn \${done ? 'success' : ''}" onclick="toggleCareer('\${k}')">\${ico(done ? 'checkCircle' : 'circle', 14)}<span>\${done ? '已练成' : '打卡'}</span></button>
            </div>
            <div class="muted" style="margin-top:4px;">\${esc(g.why_needed)}</div>
            <div style="margin-top:6px;"><strong>怎么练：</strong>\${esc(g.practice_method)}</div>
            <div style="margin-top:6px; color:#047857; font-weight:600; display:flex; align-items:flex-start; gap:6px;">\${ico('check', 16)}<span><strong>交付物：</strong>\${esc(g.deliverable)}</span></div>
          </div>
        \`;
      }).join('')}
    </div>
    <div class="card">
      <h3>\${ico('checkCircle', 17)}<span>分阶段行动打卡</span></h3>
      \${(p.roadmap || []).map((ph, pi) => \`
        <div class="box">
          <strong>\${esc(ph.phase)}</strong>
          <div class="muted">\${esc(ph.goal)}</div>
          \${(ph.actions || []).map((act, ai) => {
            const k = 'act_' + pi + '_' + ai;
            const done = Boolean(state.careerDone[k] || act.done);
            const txt = typeof act === 'string' ? act : act.text;
            return \`<div style="margin-top:8px; display:flex; gap:9px; align-items:flex-start; cursor:pointer;" onclick="toggleCareer('\${k}')"><span style="color:\${done ? '#059669' : '#64748b'}; margin-top:2px;">\${ico(done ? 'checkCircle' : 'circle', 18)}</span><span style="\${done ? 'text-decoration:line-through; color:#64748b;' : ''}">\${esc(txt)}</span></div>\`;
          }).join('')}
        </div>
      \`).join('')}
    </div>
  \`;
}

function downloadLocalBackupFile() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'jobmate-ai-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已下载本地备份文件 jobmate-ai-backup.json');
}

function importLocalBackupFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || '{}'));
      if (!parsed || typeof parsed !== 'object') throw new Error('无效备份文件');
      state = {
        practiced: parsed.practiced || {},
        careerDone: parsed.careerDone || {},
        customQuestions: parsed.customQuestions || {},
        customJobs: Array.isArray(parsed.customJobs) ? parsed.customJobs : [],
        customCareerPlan: parsed.customCareerPlan || null,
        mobileResume: parsed.mobileResume || null,
        mobileApi: parsed.mobileApi || state.mobileApi,
      };
      saveState();
      toast('备份已导入，正在刷新页面...');
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      toast('导入失败：' + e.message);
    }
  };
  reader.readAsText(file, 'utf8');
}

function clearLocalData() {
  if (!confirm('确认清空当前浏览器本地保存的简历、岗位、自定义题与打卡记录吗？')) return;
  localStorage.removeItem(STORE_KEY);
  location.reload();
}

if (/MicroMessenger/i.test(navigator.userAgent || '')) {
  const b = document.getElementById('wx-banner');
  if (b) b.style.display = 'block';
}
initSelectors();
renderJobs();
renderPrep();
renderCareer();
renderChatBank();
calcSalary();
</script>
</body>
</html>`;
}

export function exportMobileOfflineFile({ mode = 'generic' } = {}) {
  ensureDataDirs();
  const fileName = mode === 'personal' ? '求职助手-个人离线版.html' : '求职助手-通用手机版.html';
  const outPath = path.join(PATHS.dataDir, fileName);
  const html = buildMobileOfflineHtml({ mode });
  fs.writeFileSync(outPath, html, 'utf8');
  return { outPath, bytes: Buffer.byteLength(html, 'utf8'), mode };
}

/**
 * 构建用于 GitHub Pages（docs/ 目录）的纯净通用在线手机/桌面静态站点（零个人信息）
 */
export function buildGitHubPagesSite(docsDir) {
  fs.mkdirSync(docsDir, { recursive: true });
  const html = buildMobileOfflineHtml({ mode: 'generic' });
  const indexPath = path.join(docsDir, 'index.html');
  const manifestPath = path.join(docsDir, 'manifest.webmanifest');
  const noJekyllPath = path.join(docsDir, '.nojekyll');

  fs.writeFileSync(indexPath, html, 'utf8');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        name: '职伴 AI (JobMate-AI) · 全行业求职助手',
        short_name: '职伴AI',
        start_url: './',
        display: 'standalone',
        background_color: '#f4f6fb',
        theme_color: '#0f172a',
        description: '零隐私上云、13大行业每岗15+深度题库、覆盖应届生/AI/社招的开源求职与面试谈薪助手',
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(noJekyllPath, '', 'utf8');

  return {
    docsDir,
    indexPath,
    manifestPath,
    bytes: Buffer.byteLength(html, 'utf8'),
  };
}
