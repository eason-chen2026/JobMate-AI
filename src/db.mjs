import { DatabaseSync } from 'node:sqlite';
import { PATHS, ensureDataDirs } from './paths.mjs';

let dbInstance = null;

// 支持的投递全生命周期状态
export const JOB_STATUSES = [
  'new',              // 待分析
  'ready',            // 已定制简历与话术，待确认发送
  'greeted',          // 已打招呼/已投递
  'read',             // HR 已读未回
  'replied',          // HR 已回复
  'resume_requested', // 已索要/发送附件简历
  'interview',        // 已约面/面试中
  'rejected',         // 未通过/不合适
  'archived',         // 已归档/放弃
];

export function getDb() {
  if (dbInstance) return dbInstance;
  ensureDataDirs();
  dbInstance = new DatabaseSync(PATHS.dbPath);
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'Boss直聘',
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      city TEXT DEFAULT '',
      salary TEXT DEFAULT '',
      url TEXT DEFAULT '',
      jd_text TEXT NOT NULL,
      match_score INTEGER,
      match_summary TEXT DEFAULT '',
      risk_flags TEXT DEFAULT '[]',
      missing_skills TEXT DEFAULT '[]',
      tailored_resume_json TEXT DEFAULT '',
      resume_pdf_path TEXT DEFAULT '',
      greetings_json TEXT DEFAULT '[]',
      selected_greeting TEXT DEFAULT '',
      greeting_style TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      tier TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      greeted_at TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER,
      mode TEXT NOT NULL,
      provider TEXT NOT NULL,
      replacements_count INTEGER NOT NULL DEFAULT 0,
      hit_fields TEXT DEFAULT '[]',
      sanitized_preview TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interview_preps (
      job_id INTEGER PRIMARY KEY,
      questions_json TEXT DEFAULT '[]',
      reverse_questions_json TEXT DEFAULT '[]',
      salary_plan_json TEXT DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coach_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER,
      session_type TEXT NOT NULL,
      persona TEXT DEFAULT '',
      messages_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS career_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_type TEXT NOT NULL,
      career_stage TEXT NOT NULL DEFAULT 'mid_career',
      target_role TEXT DEFAULT '',
      user_input_json TEXT DEFAULT '{}',
      plan_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // 兼容旧版数据库：自动补充 tier（练手/主力/进阶）字段
  const cols = dbInstance.prepare('PRAGMA table_info(jobs)').all();
  if (!cols.some((c) => c.name === 'tier')) {
    dbInstance.exec("ALTER TABLE jobs ADD COLUMN tier TEXT DEFAULT '';");
  }

  return dbInstance;
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function hydrateJob(row) {
  if (!row) return null;
  return {
    ...row,
    risk_flags: safeJsonParse(row.risk_flags, []),
    missing_skills: safeJsonParse(row.missing_skills, []),
    tailored_resume: safeJsonParse(row.tailored_resume_json, null),
    greetings: safeJsonParse(row.greetings_json, []),
  };
}

export function listJobs(statusFilter = '') {
  const db = getDb();
  const rows = statusFilter
    ? db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY updated_at DESC, id DESC').all(statusFilter)
    : db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC, id DESC').all();
  return rows.map(hydrateJob);
}

export function getJobById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id));
  return hydrateJob(row);
}

export function createJob(input) {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO jobs (platform, company, title, city, salary, url, jd_text, status, tier, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)
  `);
  const res = stmt.run(
    (input.platform || 'Boss直聘').trim(),
    (input.company || '未命名公司').trim(),
    (input.title || '未命名岗位').trim(),
    (input.city || '').trim(),
    (input.salary || '').trim(),
    (input.url || '').trim(),
    (input.jd_text || '').trim(),
    String(input.tier || '').trim(),
    (input.notes || '').trim(),
    now,
    now
  );
  return getJobById(res.lastInsertRowid);
}

export function updateJob(id, patch) {
  const db = getDb();
  const existing = getJobById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const nextStatus = patch.status && JOB_STATUSES.includes(patch.status) ? patch.status : existing.status;
  const greetedAt =
    patch.greeted_at !== undefined
      ? patch.greeted_at
      : !existing.greeted_at && ['greeted', 'read', 'replied', 'resume_requested', 'interview'].includes(nextStatus)
        ? now
        : existing.greeted_at;

  db.prepare(`
    UPDATE jobs SET
      platform = ?,
      company = ?,
      title = ?,
      city = ?,
      salary = ?,
      url = ?,
      jd_text = ?,
      match_score = ?,
      match_summary = ?,
      risk_flags = ?,
      missing_skills = ?,
      tailored_resume_json = ?,
      resume_pdf_path = ?,
      greetings_json = ?,
      selected_greeting = ?,
      greeting_style = ?,
      status = ?,
      tier = ?,
      notes = ?,
      updated_at = ?,
      greeted_at = ?
    WHERE id = ?
  `).run(
    patch.platform ?? existing.platform,
    patch.company ?? existing.company,
    patch.title ?? existing.title,
    patch.city ?? existing.city,
    patch.salary ?? existing.salary,
    patch.url ?? existing.url,
    patch.jd_text ?? existing.jd_text,
    patch.match_score !== undefined ? patch.match_score : existing.match_score,
    patch.match_summary ?? existing.match_summary,
    patch.risk_flags !== undefined ? JSON.stringify(patch.risk_flags) : JSON.stringify(existing.risk_flags),
    patch.missing_skills !== undefined ? JSON.stringify(patch.missing_skills) : JSON.stringify(existing.missing_skills),
    patch.tailored_resume !== undefined
      ? JSON.stringify(patch.tailored_resume)
      : existing.tailored_resume_json,
    patch.resume_pdf_path ?? existing.resume_pdf_path,
    patch.greetings !== undefined ? JSON.stringify(patch.greetings) : JSON.stringify(existing.greetings),
    patch.selected_greeting ?? existing.selected_greeting,
    patch.greeting_style ?? existing.greeting_style,
    nextStatus,
    patch.tier !== undefined ? String(patch.tier || '').trim() : existing.tier || '',
    patch.notes ?? existing.notes,
    now,
    greetedAt,
    Number(id)
  );

  return getJobById(id);
}

export function deleteJob(id) {
  const db = getDb();
  const jobId = Number(id);
  db.prepare('DELETE FROM interview_preps WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM coach_sessions WHERE job_id = ?').run(jobId);
  const res = db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  return res.changes > 0;
}

export function getInterviewPrep(jobId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM interview_preps WHERE job_id = ?').get(Number(jobId));
  if (!row) {
    return {
      job_id: Number(jobId),
      questions: [],
      reverse_questions: [],
      salary_plan: {},
      updated_at: '',
    };
  }
  return {
    job_id: row.job_id,
    questions: safeJsonParse(row.questions_json, []),
    reverse_questions: safeJsonParse(row.reverse_questions_json, []),
    salary_plan: safeJsonParse(row.salary_plan_json, {}),
    updated_at: row.updated_at,
  };
}

export function upsertInterviewPrep(jobId, patch = {}) {
  const db = getDb();
  const existing = getInterviewPrep(jobId);
  const now = new Date().toISOString();
  const questions = patch.questions !== undefined ? patch.questions : existing.questions;
  const reverseQuestions =
    patch.reverse_questions !== undefined ? patch.reverse_questions : existing.reverse_questions;
  const salaryPlan =
    patch.salary_plan !== undefined
      ? { ...(existing.salary_plan || {}), ...(patch.salary_plan || {}) }
      : existing.salary_plan;

  db.prepare(`
    INSERT INTO interview_preps (job_id, questions_json, reverse_questions_json, salary_plan_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      questions_json = excluded.questions_json,
      reverse_questions_json = excluded.reverse_questions_json,
      salary_plan_json = excluded.salary_plan_json,
      updated_at = excluded.updated_at
  `).run(
    Number(jobId),
    JSON.stringify(questions || []),
    JSON.stringify(reverseQuestions || []),
    JSON.stringify(salaryPlan || {}),
    now
  );

  return getInterviewPrep(jobId);
}

function hydrateCoachSession(row) {
  if (!row) return null;
  return {
    ...row,
    messages: safeJsonParse(row.messages_json, []),
  };
}

export function listCoachSessions(jobId = null, sessionType = '') {
  const db = getDb();
  let rows;
  if (jobId && sessionType) {
    rows = db
      .prepare('SELECT * FROM coach_sessions WHERE job_id = ? AND session_type = ? ORDER BY updated_at DESC, id DESC')
      .all(Number(jobId), sessionType);
  } else if (jobId) {
    rows = db
      .prepare('SELECT * FROM coach_sessions WHERE job_id = ? ORDER BY updated_at DESC, id DESC')
      .all(Number(jobId));
  } else if (sessionType) {
    rows = db
      .prepare('SELECT * FROM coach_sessions WHERE session_type = ? ORDER BY updated_at DESC, id DESC')
      .all(sessionType);
  } else {
    rows = db.prepare('SELECT * FROM coach_sessions ORDER BY updated_at DESC, id DESC').all();
  }
  return rows.map(hydrateCoachSession);
}

export function getCoachSessionById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM coach_sessions WHERE id = ?').get(Number(id));
  return hydrateCoachSession(row);
}

export function createCoachSession({ jobId = null, sessionType, persona = '', messages = [] }) {
  const db = getDb();
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO coach_sessions (job_id, session_type, persona, messages_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(jobId ? Number(jobId) : null, sessionType, persona, JSON.stringify(messages || []), now, now);
  return getCoachSessionById(res.lastInsertRowid);
}

export function updateCoachSession(id, patch = {}) {
  const db = getDb();
  const existing = getCoachSessionById(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const persona = patch.persona ?? existing.persona;
  const messages = patch.messages !== undefined ? patch.messages : existing.messages;
  db.prepare(
    `UPDATE coach_sessions SET persona = ?, messages_json = ?, updated_at = ? WHERE id = ?`
  ).run(persona, JSON.stringify(messages || []), now, Number(id));
  return getCoachSessionById(id);
}

export function deleteCoachSession(id) {
  const db = getDb();
  const res = db.prepare('DELETE FROM coach_sessions WHERE id = ?').run(Number(id));
  return res.changes > 0;
}

function hydrateCareerPlan(row) {
  if (!row) return null;
  return {
    ...row,
    user_input: safeJsonParse(row.user_input_json, {}),
    plan: safeJsonParse(row.plan_json, {}),
  };
}

export function listCareerPlans(limit = 20) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM career_plans ORDER BY updated_at DESC, id DESC LIMIT ?')
    .all(Number(limit));
  return rows.map(hydrateCareerPlan);
}

export function getCareerPlanById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM career_plans WHERE id = ?').get(Number(id));
  return hydrateCareerPlan(row);
}

export function createCareerPlan({ planType, careerStage = 'mid_career', targetRole = '', userInput = {}, plan = {} }) {
  const db = getDb();
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT INTO career_plans (plan_type, career_stage, target_role, user_input_json, plan_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      planType,
      careerStage,
      String(targetRole || '').trim(),
      JSON.stringify(userInput || {}),
      JSON.stringify(plan || {}),
      now,
      now
    );
  return getCareerPlanById(res.lastInsertRowid);
}

export function updateCareerPlan(id, patch = {}) {
  const db = getDb();
  const existing = getCareerPlanById(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE career_plans SET plan_type = ?, career_stage = ?, target_role = ?, user_input_json = ?, plan_json = ?, updated_at = ? WHERE id = ?`
  ).run(
    patch.plan_type ?? existing.plan_type,
    patch.career_stage ?? existing.career_stage,
    patch.target_role ?? existing.target_role,
    JSON.stringify(patch.user_input !== undefined ? patch.user_input : existing.user_input),
    JSON.stringify(patch.plan !== undefined ? patch.plan : existing.plan),
    now,
    Number(id)
  );
  return getCareerPlanById(id);
}

export function deleteCareerPlan(id) {
  const db = getDb();
  const res = db.prepare('DELETE FROM career_plans WHERE id = ?').run(Number(id));
  return res.changes > 0;
}

export function addAuditLog({ jobId = null, mode, provider, replacementsCount, hitFields, sanitizedPreview }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_logs (job_id, mode, provider, replacements_count, hit_fields, sanitized_preview, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId ? Number(jobId) : null,
    mode,
    provider,
    replacementsCount || 0,
    JSON.stringify(hitFields || []),
    String(sanitizedPreview || '').slice(0, 1200),
    now
  );
}

export function listAuditLogs(limit = 30) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
    .all(Number(limit));
  return rows.map((r) => ({
    ...r,
    hit_fields: safeJsonParse(r.hit_fields, []),
  }));
}

/**
 * 复盘统计：漏斗转化率、话术风格对比、平台对比、常见技能缺口与改进建议
 */
export function buildReviewStats() {
  const jobs = listJobs();
  const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0]));
  for (const job of jobs) {
    counts[job.status] = (counts[job.status] || 0) + 1;
  }

  const sentSet = new Set(['greeted', 'read', 'replied', 'resume_requested', 'interview', 'rejected']);
  const readSet = new Set(['read', 'replied', 'resume_requested', 'interview']);
  const repliedSet = new Set(['replied', 'resume_requested', 'interview']);
  const resumeReqSet = new Set(['resume_requested', 'interview']);

  const sentJobs = jobs.filter((j) => sentSet.has(j.status) || Boolean(j.greeted_at));
  const totalSent = sentJobs.length;
  const totalRead = sentJobs.filter((j) => readSet.has(j.status)).length;
  const totalReplied = sentJobs.filter((j) => repliedSet.has(j.status)).length;
  const totalResumeReq = sentJobs.filter((j) => resumeReqSet.has(j.status)).length;
  const totalInterview = sentJobs.filter((j) => j.status === 'interview').length;

  const pct = (a, b) => (b > 0 ? Number(((a / b) * 100).toFixed(1)) : 0);

  // 按话术风格对比回复率
  const byStyleMap = new Map();
  for (const job of sentJobs) {
    const key = job.greeting_style || '未标记风格';
    const item = byStyleMap.get(key) || { style: key, sent: 0, replied: 0, interview: 0 };
    item.sent += 1;
    if (repliedSet.has(job.status)) item.replied += 1;
    if (job.status === 'interview') item.interview += 1;
    byStyleMap.set(key, item);
  }
  const byStyle = [...byStyleMap.values()].map((item) => ({
    ...item,
    replyRate: pct(item.replied, item.sent),
    interviewRate: pct(item.interview, item.sent),
  }));

  // 按平台对比
  const byPlatformMap = new Map();
  for (const job of sentJobs) {
    const key = job.platform || '其他';
    const item = byPlatformMap.get(key) || { platform: key, sent: 0, replied: 0, interview: 0 };
    item.sent += 1;
    if (repliedSet.has(job.status)) item.replied += 1;
    if (job.status === 'interview') item.interview += 1;
    byPlatformMap.set(key, item);
  }
  const byPlatform = [...byPlatformMap.values()].map((item) => ({
    ...item,
    replyRate: pct(item.replied, item.sent),
    interviewRate: pct(item.interview, item.sent),
  }));

  // 高频技能缺口统计
  const skillGapCounter = new Map();
  for (const job of jobs) {
    for (const skill of job.missing_skills || []) {
      const normalized = String(skill).trim();
      if (!normalized) continue;
      skillGapCounter.set(normalized, (skillGapCounter.get(normalized) || 0) + 1);
    }
  }
  const topMissingSkills = [...skillGapCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([skill, count]) => ({ skill, count }));

  // 自动复盘诊断建议
  const insights = [];
  if (totalSent === 0) {
    insights.push('暂无已投递记录，完成首批 5~10 个岗位投递并更新状态后，这里会自动给出转化率诊断。');
  } else {
    const readRate = pct(totalRead, totalSent);
    const replyRate = pct(totalReplied, totalSent);
    const interviewRate = pct(totalInterview, totalReplied || totalSent);
    if (readRate < 35) {
      insights.push(`当前已读率偏低（${readRate}%）：建议优先筛选“刚刚活跃/今日活跃”的 HR，并避开长期挂岗的职位。`);
    }
    if (totalRead >= 5 && replyRate < 15) {
      insights.push(`已读但回复率偏低（${replyRate}%）：说明打招呼前两句抓力不足，建议把“年限+核心量化成果+与岗位最匹配技能”前置到第一句话。`);
    }
    if (totalResumeReq >= 3 && totalInterview === 0) {
      insights.push('已有多次要简历但尚未约面：重点检查定制 PDF 简历上半屏（个人总结和最近一段项目）是否直接命中 JD 的核心硬指标。');
    }
    if (topMissingSkills.length > 0) {
      insights.push(`高频缺口技能集中在：${topMissingSkills.slice(0, 3).map((x) => x.skill).join('、')}，可在主简历中补充相关实践或在面试前重点准备。`);
    }
    if (insights.length === 0) {
      insights.push(`当前投递节奏健康（回复率 ${replyRate}%，约面转化表现良好），建议继续放大表现最好的话术风格。`);
    }
  }

  return {
    totalJobs: jobs.length,
    counts,
    funnel: {
      sent: totalSent,
      read: totalRead,
      replied: totalReplied,
      resumeRequested: totalResumeReq,
      interview: totalInterview,
      readRate: pct(totalRead, totalSent),
      replyRate: pct(totalReplied, totalSent),
      resumeRate: pct(totalResumeReq, totalSent),
      interviewRate: pct(totalInterview, totalSent),
    },
    byStyle,
    byPlatform,
    topMissingSkills,
    insights,
  };
}
