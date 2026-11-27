import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PATHS, ensureDataDirs } from './paths.mjs';
import { detectBrowserExecutable } from './browser.mjs';
import { loadMasterResume, loadPrivateProfile } from './privacy.mjs';
import { getJobById, updateJob } from './db.mjs';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitizeFileName(str) {
  return (
    String(str || 'untitled')
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'untitled'
  );
}

function isPlaceholderContact(val) {
  const s = String(val || '').trim();
  return !s || s.includes('请填写') || s === '13800000000' || s === 'yourname@example.com' || s === 'your_wechat_id';
}

function renderSummaryHtml(summary) {
  const lines = Array.isArray(summary)
    ? summary.map((s) => String(s || '').trim()).filter(Boolean)
    : String(summary || '')
        .split(/\r?\n/)
        .map((s) => s.replace(/^[•·\-*]\s*/, '').trim())
        .filter(Boolean);

  if (!lines.length) return '';
  if (lines.length === 1) {
    return `<p class="summary">${escapeHtml(lines[0])}</p>`;
  }
  return `<ul class="summary-list">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
}

function renderSkillsHtml(skills) {
  const items = (skills || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!items.length) return '';

  // 如果包含「分类名：能力列表」结构，采用更清晰的商务表格行排版；否则使用胶囊标签
  const hasCategorized = items.some((s) => /^[^：:]{2,14}[：:]/.test(s));
  if (hasCategorized) {
    return `<div class="skill-rows">${items
      .map((item) => {
        const m = item.match(/^([^：:]{2,14})[：:]\s*(.+)$/);
        if (m) {
          return `<div class="skill-row"><span class="skill-cat">${escapeHtml(m[1])}：</span><span>${escapeHtml(m[2])}</span></div>`;
        }
        return `<div class="skill-row">${escapeHtml(item)}</div>`;
      })
      .join('')}</div>`;
  }

  return `<div class="skills">${items.map((s) => `<span class="skill-chip">${escapeHtml(s)}</span>`).join('')}</div>`;
}

/**
 * 渲染简洁专业、ATS 友好的中文简历 HTML（支持公司下嵌套多段品牌/项目，仅本地拼入真实联系方式）
 */
export function renderResumeHtml(job) {
  const profile = loadPrivateProfile();
  const master = loadMasterResume();
  const resume = job?.tailored_resume || master;
  const basicInfo = resume.basicInfo || master.basicInfo || '';

  const contactItems = [
    !isPlaceholderContact(profile.phone) && `手机：${profile.phone}`,
    !isPlaceholderContact(profile.email) && `邮箱：${profile.email}`,
    !isPlaceholderContact(profile.wechat) && `微信：${profile.wechat}`,
    profile.location && `期望城市：${profile.location}`,
  ].filter(Boolean);

  const summaryBlock = renderSummaryHtml(resume.summary);
  const skillsBlock = renderSkillsHtml(resume.skills);

  const experiencesHtml = (resume.experiences || [])
    .map((exp) => {
      const companyTitle = [exp.company, exp.role].filter(Boolean).join(' · ');
      const companyHighlights = (exp.highlights || []).length
        ? `<ul>${exp.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`
        : '';

      const subProjectsHtml = (exp.subProjects || []).length
        ? `<div class="subprojects">${exp.subProjects
            .map(
              (sp) => `
          <div class="subproject">
            <div class="sub-head">
              <div class="sub-title">${escapeHtml(sp.name)}${sp.role ? ` <span class="sub-role">${escapeHtml(sp.role)}</span>` : ''}</div>
              <div class="entry-period">${escapeHtml(sp.period)}</div>
            </div>
            ${(sp.highlights || []).length ? `<ul>${sp.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>` : ''}
          </div>
        `
            )
            .join('')}</div>`
        : '';

      return `
      <div class="entry">
        <div class="entry-head">
          <div class="entry-title">${escapeHtml(companyTitle)}</div>
          <div class="entry-period">${escapeHtml(exp.period)}</div>
        </div>
        ${companyHighlights}
        ${subProjectsHtml}
      </div>
    `;
    })
    .join('');

  const projectsHtml = (resume.projects || [])
    .map(
      (proj) => `
      <div class="entry">
        <div class="entry-head">
          <div class="entry-title">${escapeHtml(proj.name)}${proj.role ? ` · ${escapeHtml(proj.role)}` : ''}</div>
          <div class="entry-period">${escapeHtml(proj.period)}</div>
        </div>
        <ul>
          ${(proj.highlights || []).map((h) => `<li>${escapeHtml(h)}</li>`).join('')}
        </ul>
      </div>
    `
    )
    .join('');

  const educationHtml = (resume.education || [])
    .map(
      (edu) => `
      <div class="entry-head edu-row">
        <div class="entry-title">${escapeHtml(edu.school)}${edu.degree ? ` · ${escapeHtml(edu.degree)}` : ''}</div>
        <div class="entry-period">${escapeHtml(edu.period)}</div>
      </div>
    `
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(profile.name || '个人简历')} - ${escapeHtml(job?.title || resume.headline || '')}</title>
<style>
  @page { size: A4; margin: 11mm 13mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
    color: #1f2937;
    font-size: 9.8pt;
    line-height: 1.48;
    background: #ffffff;
  }
  .page { max-width: 780px; margin: 0 auto; }
  header {
    border-bottom: 1.8px solid #1e3a8a;
    padding-bottom: 8px;
    margin-bottom: 11px;
  }
  .name-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
  }
  h1 { margin: 0; font-size: 19pt; color: #111827; letter-spacing: 1px; }
  .headline { font-size: 10.8pt; font-weight: 600; color: #1e40af; text-align: right; }
  .basic-info {
    margin-top: 4px;
    font-size: 9.2pt;
    color: #374151;
  }
  .contacts {
    margin-top: 4px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    font-size: 9pt;
    color: #4b5563;
  }
  section { margin-bottom: 10px; }
  h2 {
    margin: 0 0 6px 0;
    font-size: 10.8pt;
    color: #111827;
    border-bottom: 1px solid #cbd5e1;
    padding-bottom: 3px;
    letter-spacing: 0.5px;
  }
  .summary { margin: 0; color: #374151; }
  .summary-list { margin: 0; padding-left: 16px; }
  .summary-list li { margin-bottom: 2.5px; }
  .skills { display: flex; flex-wrap: wrap; gap: 5px; }
  .skill-chip {
    background: #eff6ff;
    color: #1e40af;
    border: 1px solid #dbeafe;
    border-radius: 4px;
    padding: 1.5px 7px;
    font-size: 9pt;
  }
  .skill-rows { display: flex; flex-direction: column; gap: 2.5px; font-size: 9.3pt; }
  .skill-cat { font-weight: 700; color: #111827; }
  .entry { margin-bottom: 8px; }
  .entry-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 2px;
  }
  .entry-title { font-weight: 700; color: #111827; font-size: 10.2pt; }
  .entry-period { color: #6b7280; font-size: 9pt; white-space: nowrap; }
  .subprojects {
    margin-top: 5px;
    margin-left: 6px;
    padding-left: 10px;
    border-left: 2px solid #dbeafe;
  }
  .subproject { margin-bottom: 6px; page-break-inside: avoid; }
  .subproject:last-child { margin-bottom: 0; }
  .sub-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 2px;
  }
  .sub-title { font-weight: 700; color: #1e3a8a; font-size: 9.8pt; }
  .sub-role { font-weight: 500; color: #4b5563; margin-left: 6px; font-size: 9.2pt; }
  ul { margin: 2px 0 0 0; padding-left: 16px; }
  li { margin-bottom: 2px; }
  .edu-row { margin-bottom: 3px; }
</style>
</head>
<body>
  <div class="page">
    <header>
      <div class="name-row">
        <h1>${escapeHtml(isPlaceholderContact(profile.name) ? '候选人' : profile.name)}</h1>
        <div class="headline">${escapeHtml(resume.headline || job?.title || '')}</div>
      </div>
      ${basicInfo ? `<div class="basic-info">${escapeHtml(basicInfo)}</div>` : ''}
      ${contactItems.length ? `<div class="contacts">${contactItems.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
    </header>

    ${summaryBlock ? `<section><h2>个人优势</h2>${summaryBlock}</section>` : ''}
    ${experiencesHtml ? `<section><h2>工作经历</h2>${experiencesHtml}</section>` : ''}
    ${projectsHtml ? `<section><h2>重点项目</h2>${projectsHtml}</section>` : ''}
    ${skillsBlock ? `<section><h2>核心能力</h2>${skillsBlock}</section>` : ''}
    ${educationHtml ? `<section><h2>教育背景</h2>${educationHtml}</section>` : ''}
  </div>
</body>
</html>`;
}

/**
 * 调用本机 Chrome/Edge 无头模式离线渲染高清 PDF 简历（零第三方服务）
 */
export function generateJobResumePdf(jobId) {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);

  ensureDataDirs();
  const browserExe = detectBrowserExecutable();
  if (!browserExe) {
    throw new Error('未检测到 Chrome 或 Edge 浏览器，无法离线生成 PDF。');
  }

  const baseName = `job_${job.id}_${sanitizeFileName(job.company)}_${sanitizeFileName(job.title)}`;
  const htmlPath = path.join(PATHS.resumesDir, `${baseName}.html`);
  const pdfPath = path.join(PATHS.resumesDir, `${baseName}.pdf`);

  const html = renderResumeHtml(job);
  fs.writeFileSync(htmlPath, html, 'utf8');

  // 使用独立临时无头目录，避免和已打开的浏览器冲突
  const headlessProfile = path.join(PATHS.dataDir, '.headless-pdf-tmp');
  fs.mkdirSync(headlessProfile, { recursive: true });

  const fileUrl = pathToFileURL(htmlPath).href;
  execFileSync(
    browserExe,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      `--user-data-dir=${headlessProfile}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      fileUrl,
    ],
    {
      windowsHide: true,
      timeout: 30000,
    }
  );

  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < 500) {
    throw new Error('PDF 渲染失败，未生成有效文件。');
  }

  const updated = updateJob(job.id, { resume_pdf_path: pdfPath });
  return {
    job: updated,
    htmlPath,
    pdfPath,
  };
}
