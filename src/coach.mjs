import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDataDirs } from './paths.mjs';
import {
  addAuditLog,
  createCoachSession,
  getCoachSessionById,
  getInterviewPrep,
  getJobById,
  listCoachSessions,
  updateCoachSession,
  upsertInterviewPrep,
} from './db.mjs';
import {
  loadLocalConfig,
  loadMasterResume,
  loadPrivateProfile,
  restoreObjectDeep,
  sanitizeText,
} from './privacy.mjs';
import {
  CAREER_STAGES,
  ROLE_TEMPLATES,
  UNIVERSAL_SALARY_TRAPS,
  buildFullReverseChecklist,
  detectRoleTemplate,
  getFullQuestionsForTemplate,
  getRoleTemplateById,
} from './role-templates.mjs';

function extractJsonObject(rawText) {
  const trimmed = String(rawText || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('返回内容无法解析为合法 JSON，请检查格式。');
  }
}

/**
 * 调用官方 API 的通用方法（仅模式 A 使用，严格先脱敏并记审计）
 */
async function callOfficialApiJson({ jobId = null, systemInstruction, userPrompt, sanitized }) {
  const config = loadLocalConfig();
  if (!config.apiKey) {
    throw new Error('当前未配置官方 API Key。你可以在「隐私与 AI 设置」填入 Key，或使用模式 B 导出脱敏任务包。');
  }

  addAuditLog({
    jobId,
    mode: 'api',
    provider: `${config.provider}:${config.model}`,
    replacementsCount: sanitized.replacementsCount,
    hitFields: sanitized.hitFields,
    sanitizedPreview: sanitized.sanitizedText,
  });

  let rawResponseText = '';
  if (config.provider === 'gemini') {
    const model = config.model || 'gemini-2.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.35, responseMimeType: 'application/json' },
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`Gemini API 调用失败 (${resp.status}): ${data?.error?.message || JSON.stringify(data)}`);
    }
    rawResponseText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } else {
    const baseUrl =
      config.provider === 'deepseek'
        ? 'https://api.deepseek.com/chat/completions'
        : config.baseUrl || 'https://api.openai.com/v1/chat/completions';
    const model =
      config.model || (config.provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini');
    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.35,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`API 调用失败 (${resp.status}): ${data?.error?.message || JSON.stringify(data)}`);
    }
    rawResponseText = data?.choices?.[0]?.message?.content || '';
  }
  return extractJsonObject(rawResponseText);
}

function buildSanitizedContextForJob(job) {
  const profile = loadPrivateProfile();
  const resume = job.tailored_resume || loadMasterResume();
  const payload = {
    resume,
    targetJob: {
      id: job.id,
      platform: job.platform,
      company: job.company,
      title: job.title,
      city: job.city,
      salary: job.salary,
      jd_text: job.jd_text,
      risk_flags: job.risk_flags || [],
      missing_skills: job.missing_skills || [],
    },
  };
  return {
    profile,
    sanitized: sanitizeText(JSON.stringify(payload, null, 2), profile),
  };
}

/* =========================================================
 * 模块 1：岗位专属面试题库预测 + 深度参考答案 + 连环追问（双模式 A / B + 岗位模板库）
 * ========================================================= */
function buildInterviewPrepPrompt(job, options = {}) {
  const { sanitized } = buildSanitizedContextForJob(job);
  const stage =
    CAREER_STAGES.find((s) => s.id === options.careerStage) || CAREER_STAGES[1];
  const tpl = options.templateId
    ? getRoleTemplateById(options.templateId)
    : detectRoleTemplate(job.title, job.jd_text);

  const systemInstruction = `你是顶级中文招聘面试官兼求职深度辅导专家，擅长辅导各类岗位（AI/大模型、电商直播运营、带货主播、达人BD、产品/研发、应届大学生及管理者）。
当前候选人阶段：${stage.label}（${stage.summary}）。
参考岗位类型：${tpl.name}。
请根据候选人的真实简历与目标岗位 JD，预测该岗位最可能考到的 **12~14 道深度分层高频面试题**，并给出足够详尽、口语化、可直接实战的高分示范答案与连环追问应对。
必须遵守以下铁律：
1. 100% 忠实于候选人真实经历与数据，严禁编造任何简历中不存在的业绩、公司或项目；若为应届生则基于实习/校园项目/学习潜力作答；若为社招短板则教候选人诚实承接并转化为可迁移方法论。
2. 答案必须有深度与细节（每道题示范回答 300~500 字），拒绝空泛套话；必须附带面试官最可能接着抛出的 2 个「连环追问 + 破局要点」。
3. 保留脱敏占位符（如 {{SENSITIVE_1}}），不要猜测隐私信息。
4. 必须只输出合法纯 JSON 对象（不要 Markdown 代码块包裹），字段严格如下：
{
  "questions": [
    {
      "id": "q1",
      "category": "核心业务深挖 | 实操情景推演 | 团队与跨部门管理 | 短板与敏感追问 | 动机与薪资稳定性",
      "question": "面试官可能会问的原话",
      "intent": "面试官这道题真正想考察什么（60字以内）",
      "framework": "3~4点核心答题框架提纲，方便候选人临场快速抓结构",
      "answer": "基于候选人真实经历与数据的完整口语化高分参考答案（STAR结构，300~500字，详尽可背诵）",
      "followUps": [
        "连环追问1：面试官可能接着追问的尖锐细节 → 破局应对要点",
        "连环追问2：继续深挖的边界问题 → 破局应对要点"
      ],
      "pitfalls": "这道题最容易踩的扣分坑（80字以内）"
    }
  ],
  "reverse_questions": [
    {
      "question": "针对该岗位量身定制的高分反问面试官问题（至少5个，覆盖工作职责、业务卡点、团队配置、薪资结构与作息保障）",
      "purpose": "这样问既能体现什么格局，又能帮你核实什么真实信息"
    }
  ]
}`;

  const userPrompt = `请基于以下脱敏简历与目标岗位 JD 生成 12~14 道深度面试预测题库、长版高分参考答案、连环追问及反问清单：\n\n${sanitized.sanitizedText}`;
  return { systemInstruction, userPrompt, sanitized };
}

export function applyInterviewPrepResult(jobId, rawResult) {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);
  const parsed = typeof rawResult === 'string' ? extractJsonObject(rawResult) : rawResult;
  const profile = loadPrivateProfile();
  const restored = restoreObjectDeep(parsed, profile);

  const existing = getInterviewPrep(jobId);
  const prevPracticedMap = new Map(
    (existing.questions || []).map((q) => [String(q.question || ''), Boolean(q.practiced)])
  );

  const questions = Array.isArray(restored.questions)
    ? restored.questions
        .filter((q) => q && q.question)
        .map((q, idx) => ({
          id: String(q.id || `q${idx + 1}`),
          category: String(q.category || '核心业务深挖').trim(),
          question: String(q.question).trim(),
          intent: String(q.intent || '').trim(),
          framework: String(q.framework || '').trim(),
          answer: String(q.answer || '').trim(),
          followUps: Array.isArray(q.followUps)
            ? q.followUps.map((f) => String(f || '').trim()).filter(Boolean)
            : [],
          pitfalls: String(q.pitfalls || '').trim(),
          practiced: prevPracticedMap.get(String(q.question).trim()) || false,
        }))
    : [];

  const reverseQuestions = Array.isArray(restored.reverse_questions)
    ? restored.reverse_questions
        .filter((r) => r && r.question)
        .map((r) => ({
          question: String(r.question).trim(),
          purpose: String(r.purpose || '').trim(),
        }))
    : [];

  return upsertInterviewPrep(jobId, {
    questions,
    reverse_questions: reverseQuestions,
  });
}

/**
 * 一键将指定岗位模板的内置深度题库合并载入到当前岗位（0 秒离线可用）
 */
export function applyRoleTemplateToJob(jobId, templateId) {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);
  const tpl = templateId ? getRoleTemplateById(templateId) : detectRoleTemplate(job.title, job.jd_text);
  const existing = getInterviewPrep(jobId);
  const existingSet = new Set((existing.questions || []).map((q) => q.question));

  const mergedQuestions = [...(existing.questions || [])];
  for (const q of getFullQuestionsForTemplate(tpl.id)) {
    if (!existingSet.has(q.question)) {
      mergedQuestions.push({
        id: `tpl_${tpl.id}_${mergedQuestions.length + 1}`,
        category: q.category || '核心业务深挖',
        question: q.question,
        intent: q.intent || '',
        framework: q.framework || '',
        answer: q.answer || '',
        followUps: Array.isArray(q.followUps) ? q.followUps : [],
        pitfalls: q.pitfalls || '',
        practiced: false,
      });
    }
  }

  const existingRevSet = new Set((existing.reverse_questions || []).map((r) => r.question));
  const mergedReverse = [...(existing.reverse_questions || [])];
  for (const r of tpl.roleSpecificReverse || []) {
    if (!existingRevSet.has(r.question)) {
      mergedReverse.push(r);
    }
  }

  return upsertInterviewPrep(jobId, {
    questions: mergedQuestions,
    reverse_questions: mergedReverse,
    salary_plan: { ...(existing.salary_plan || {}), templateId: tpl.id },
  });
}

export async function runApiInterviewPrep(jobId, options = {}) {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);
  const { systemInstruction, userPrompt, sanitized } = buildInterviewPrepPrompt(job, options);
  const parsed = await callOfficialApiJson({ jobId: job.id, systemInstruction, userPrompt, sanitized });
  const prep = applyInterviewPrepResult(jobId, parsed);
  return {
    mode: 'api',
    prep,
    privacyReport: {
      replacementsCount: sanitized.replacementsCount,
      hitFields: sanitized.hitFields,
    },
  };
}

export function exportInterviewPrepCollab(jobId, options = {}) {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);
  ensureDataDirs();
  const { systemInstruction, userPrompt, sanitized } = buildInterviewPrepPrompt(job, options);
  const taskPath = path.join(PATHS.tasksDir, `task_interview_prep_job_${job.id}.md`);
  const resultPath = path.join(PATHS.tasksDir, `result_interview_prep_job_${job.id}.json`);

  const content = `# 脱敏面试题预测与高分答案任务（岗位 ID: ${job.id}）

> 本文件已经过本地隐私脱敏（命中替换 ${sanitized.replacementsCount} 处：${sanitized.hitFields.join('、') || '无敏感命中'}）。
> 把此文件路径发给 Antigravity，生成 JSON 保存到：\`${resultPath}\`

## 任务指令
${systemInstruction}

## 脱敏输入数据
${userPrompt}
`;

  fs.writeFileSync(taskPath, content, 'utf8');
  addAuditLog({
    jobId: job.id,
    mode: 'collab',
    provider: 'local-collab-interview-prep',
    replacementsCount: sanitized.replacementsCount,
    hitFields: sanitized.hitFields,
    sanitizedPreview: sanitized.sanitizedText,
  });

  return {
    mode: 'collab',
    taskPath,
    expectedResultPath: resultPath,
    promptText: `${systemInstruction}\n\n${userPrompt}`,
    privacyReport: {
      replacementsCount: sanitized.replacementsCount,
      hitFields: sanitized.hitFields,
    },
  };
}

export function importInterviewPrepCollab(jobId, jsonTextOrObj = null) {
  const resultPath = path.join(PATHS.tasksDir, `result_interview_prep_job_${jobId}.json`);
  let payload = jsonTextOrObj;
  if (!payload) {
    if (!fs.existsSync(resultPath)) {
      throw new Error(`未找到面试题库结果文件：${resultPath}，请先让 Antigravity 写入该文件或粘贴 JSON。`);
    }
    payload = fs.readFileSync(resultPath, 'utf8');
  }
  return applyInterviewPrepResult(jobId, payload);
}

/* =========================================================
 * 模块 2：AI 模拟面试（多轮互动问答 + 逐轮点评打分）
 * ========================================================= */
export function startMockInterview(jobId, persona = '业务负责人/副总') {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);
  const prep = getInterviewPrep(jobId);

  let firstQuestion = '';
  if (persona === 'HRBP') {
    firstQuestion = `你好，感谢来参加 ${job.company}「${job.title}」的面试。先花 2 分钟做个自我介绍吧，顺便聊聊你最近一段经历离职以及接下来看机会最看重什么？`;
  } else if (persona === '压力追问') {
    firstQuestion =
      prep.questions.find((q) => q.category.includes('短板') || q.category.includes('深挖'))?.question ||
      `我看你简历上写的业绩数据挺亮眼，但很多大牌直播间本身自带品牌流量——如果剥离掉大牌光环，你觉得你个人真正可复用到 ${job.company} 的核心能力是什么？请用具体案例证明。`;
  } else {
    firstQuestion =
      prep.questions[0]?.question ||
      `你好，欢迎面试 ${job.company} 的「${job.title}」。请结合你最有代表性的一个核心项目，拆解一下当时目标是多少、遇到什么瓶颈、你具体做了哪些动作拿到结果？`;
  }

  return createCoachSession({
    jobId: job.id,
    sessionType: 'mock_interview',
    persona,
    messages: [
      {
        role: 'interviewer',
        text: firstQuestion,
        createdAt: new Date().toISOString(),
      },
    ],
  });
}

function buildMockTurnPrompt(session, job, candidateAnswer) {
  const profile = loadPrivateProfile();
  const resume = job.tailored_resume || loadMasterResume();
  const payload = {
    persona: session.persona,
    targetJob: {
      company: job.company,
      title: job.title,
      salary: job.salary,
      jd_text: job.jd_text,
    },
    resume,
    conversationHistory: session.messages,
    latestCandidateAnswer: candidateAnswer,
  };
  const sanitized = sanitizeText(JSON.stringify(payload, null, 2), profile);

  const systemInstruction = `你现在扮演「${session.persona}」对候选人进行 1v1 真实模拟面试，并在每轮结束后给出专业教练级点评。
必须遵守以下铁律：
1. 忠实于候选人简历事实，不教候选人编造假数据；指出回答中空泛、逻辑跳跃或暴露短板的地方。
2. 保留脱敏占位符，不要猜测隐私信息。
3. 必须只输出合法纯 JSON 对象（不要 Markdown 代码块包裹），字段严格如下：
{
  "score": 0到100的整数总评,
  "dimensions": {
    "depth": "业务深度简评（20字内）",
    "logic": "表达逻辑简评（20字内）",
    "data": "数据说服力简评（20字内）"
  },
  "strengths": ["回答做得好的点1", "点2"],
  "improvements": ["可以立刻优化的失分点1", "点2"],
  "better_answer": "保留候选人原意但更结构化、更有说服力的示范升级版回答（180~280字）",
  "next_question": "作为${session.persona}顺着候选人刚才回答最值得深挖的细节，抛出下一道真实追问（若已聊满5轮可转为反问环节或总结）"
}`;

  const userPrompt = `请根据以下模拟面试上下文，点评候选人最新一轮回答并给出下一道追问：\n\n${sanitized.sanitizedText}`;
  return { systemInstruction, userPrompt, sanitized };
}

export function applyMockTurnFeedback(sessionId, candidateAnswer, rawFeedback) {
  const session = getCoachSessionById(sessionId);
  if (!session) throw new Error(`未找到模拟面试会话 #${sessionId}`);
  const parsed = typeof rawFeedback === 'string' ? extractJsonObject(rawFeedback) : rawFeedback;
  const profile = loadPrivateProfile();
  const restored = restoreObjectDeep(parsed, profile);

  const messages = [...(session.messages || [])];
  const lastMsg = messages[messages.length - 1];
  // 避免重复写入同一条候选人回答（模式 B 提交后暂存了回答）
  if (!lastMsg || lastMsg.role !== 'candidate' || lastMsg.text !== candidateAnswer) {
    if (candidateAnswer) {
      messages.push({
        role: 'candidate',
        text: String(candidateAnswer).trim(),
        createdAt: new Date().toISOString(),
      });
    }
  }

  messages.push({
    role: 'feedback',
    score: Number.isFinite(Number(restored.score))
      ? Math.max(0, Math.min(100, Math.round(Number(restored.score))))
      : 75,
    dimensions: restored.dimensions || {},
    strengths: Array.isArray(restored.strengths) ? restored.strengths : [],
    improvements: Array.isArray(restored.improvements) ? restored.improvements : [],
    better_answer: String(restored.better_answer || '').trim(),
    createdAt: new Date().toISOString(),
  });

  if (restored.next_question) {
    messages.push({
      role: 'interviewer',
      text: String(restored.next_question).trim(),
      createdAt: new Date().toISOString(),
    });
  }

  return updateCoachSession(sessionId, { messages });
}

export async function runApiMockTurn(sessionId, candidateAnswer) {
  const session = getCoachSessionById(sessionId);
  if (!session) throw new Error(`未找到模拟面试会话 #${sessionId}`);
  const job = getJobById(session.job_id);
  if (!job) throw new Error('关联岗位不存在');
  const cleanAns = String(candidateAnswer || '').trim();
  if (!cleanAns) throw new Error('请先输入你的回答内容。');

  const { systemInstruction, userPrompt, sanitized } = buildMockTurnPrompt(session, job, cleanAns);
  const parsed = await callOfficialApiJson({
    jobId: job.id,
    systemInstruction,
    userPrompt,
    sanitized,
  });
  const updated = applyMockTurnFeedback(sessionId, cleanAns, parsed);
  return {
    mode: 'api',
    session: updated,
    privacyReport: {
      replacementsCount: sanitized.replacementsCount,
      hitFields: sanitized.hitFields,
    },
  };
}

export function exportMockTurnCollab(sessionId, candidateAnswer) {
  const session = getCoachSessionById(sessionId);
  if (!session) throw new Error(`未找到模拟面试会话 #${sessionId}`);
  const job = getJobById(session.job_id);
  if (!job) throw new Error('关联岗位不存在');
  const cleanAns = String(candidateAnswer || '').trim();
  if (!cleanAns) throw new Error('请先输入你的回答内容。');

  ensureDataDirs();
  // 先把本轮候选人回答保存到会话里
  const messages = [...(session.messages || [])];
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'candidate' || lastMsg.text !== cleanAns) {
    messages.push({ role: 'candidate', text: cleanAns, createdAt: new Date().toISOString() });
    updateCoachSession(sessionId, { messages });
  }

  const latestSession = getCoachSessionById(sessionId);
  const { systemInstruction, userPrompt, sanitized } = buildMockTurnPrompt(latestSession, job, cleanAns);
  const taskPath = path.join(PATHS.tasksDir, `task_mock_turn_${sessionId}.md`);
  const resultPath = path.join(PATHS.tasksDir, `result_mock_turn_${sessionId}.json`);

  const content = `# 脱敏模拟面试逐轮点评任务（会话 ID: ${sessionId}，岗位: ${job.company} - ${job.title}）

> 本文件已经过本地隐私脱敏（命中替换 ${sanitized.replacementsCount} 处：${sanitized.hitFields.join('、') || '无敏感命中'}）。
> 把此文件路径发给 Antigravity，生成 JSON 保存到：\`${resultPath}\`

## 任务指令
${systemInstruction}

## 脱敏输入数据
${userPrompt}
`;

  fs.writeFileSync(taskPath, content, 'utf8');
  addAuditLog({
    jobId: job.id,
    mode: 'collab',
    provider: 'local-collab-mock-interview',
    replacementsCount: sanitized.replacementsCount,
    hitFields: sanitized.hitFields,
    sanitizedPreview: sanitized.sanitizedText,
  });

  return {
    mode: 'collab',
    session: latestSession,
    taskPath,
    expectedResultPath: resultPath,
    promptText: `${systemInstruction}\n\n${userPrompt}`,
    privacyReport: {
      replacementsCount: sanitized.replacementsCount,
      hitFields: sanitized.hitFields,
    },
  };
}

export function importMockTurnCollab(sessionId, jsonTextOrObj = null) {
  const resultPath = path.join(PATHS.tasksDir, `result_mock_turn_${sessionId}.json`);
  let payload = jsonTextOrObj;
  if (!payload) {
    if (!fs.existsSync(resultPath)) {
      throw new Error(`未找到点评结果文件：${resultPath}，请先让 Antigravity 写入该文件或粘贴 JSON。`);
    }
    payload = fs.readFileSync(resultPath, 'utf8');
  }
  return applyMockTurnFeedback(sessionId, '', payload);
}

/* =========================================================
 * 模块 3：HR 聊天互动神回复 + 本地谈薪策略计算器与压薪剧本
 * ========================================================= */
export function buildQuickChatTemplates(job, scenario, hrMessage = '') {
  const company = job?.company || '贵司';
  const title = job?.title || '该岗位';
  const salaryText = job?.salary || '目标区间';

  const map = {
    核实双休与福利: [
      {
        style: '礼貌自然确认型',
        text: `您好，感谢回复！我对 ${company}「${title}」的业务方向很感兴趣，想提前跟您核实两个基础信息方便高效推进：一是咱们团队平时的作息安排是周末双休吗？二是薪资结构大概是纯底薪还是底薪+绩效/提成呢？`,
      },
      {
        style: '业务切入顺带确认型',
        text: `收到，谢谢您的介绍！我看岗位职责和我的操盘背景契合度很高，也很看好咱们品牌的发展。方便顺便了解下目前团队的上班时间（是否周末双休）和五险一金缴纳情况吗？如果合适我这边尽快安排时间沟通。`,
      },
      {
        style: '直爽高效筛选型',
        text: `您好！为了不耽误双方时间，先确认下这个岗位是明确周末双休的吗？因为我比较看重稳定高效的长期节奏，如果作息和业务方向匹配，咱们可以约个时间细聊。`,
      },
    ],
    薪资试探与报价: [
      {
        style: '先问预算锚定型（推荐）',
        text: `您好！薪资我更看重岗位权责和长期成长空间，参考行业水平和我的过往操盘体量，我的期望大致在贵司标薪（${salaryText}）的中高档位。方便先了解下咱们这个岗位具体的定薪范围和绩效/年终结构吗？`,
      },
      {
        style: '价值锚定报价型',
        text: `您好！结合我过往核心项目操盘与团队协作经验，我希望整体月薪能落在一个能匹配业务体量的合理区间（参考 ${salaryText}），具体可以根据岗位职责边界、绩效考核标准和年终月数来综合谈，相信互相认可后薪资都好商量。`,
      },
      {
        style: '反客为主推进面试型',
        text: `您好！薪资方面我有大概心理区间，不过更希望能先跟业务负责人深入聊下咱们接下来的目标和挑战，等双方确认人岗高度匹配后，按咱们公司的定级和贡献空间来谈会更准确，您看先约个面试聊聊业务方便吗？`,
      },
    ],
    应对压薪或试用期打折: [
      {
        style: '底薪保底换绩效型',
        text: `理解公司对成本和人效的考量。我也很愿意拿结果说话，不过固定底薪关系到基本生活与稳定投入，我希望固定部分尽量靠近我的目标线；如果预算有压力，咱们可以把浮动空间放在季度/大促超额达成奖励上，我帮公司做出增量，大家双赢。`,
      },
      {
        style: '试用期不打折争取型',
        text: `关于试用期薪资，我属于能直接上手带团队拿结果的即战力，过往操盘经验可以很快帮团队少走弯路。通常行业内成熟岗位试用期是全薪，或者咱们可以把试用期缩短到 1~2 个月、设定清晰的转正业绩目标，达标即提前转正，您看这样可行吗？`,
      },
      {
        style: '坚守底线礼貌拉回型',
        text: `非常感谢您的坦诚沟通，我也很认可团队和业务。不过这个方案比我的底线差距略大，如果固定月薪能往上调整一些，或者在年终保底/半年调薪机制上书面明确一下，我这边会非常有诚意尽快推进入职。`,
      },
    ],
    回应空窗期或离职原因: [
      {
        style: '主动复盘蓄力型（推荐）',
        text: `上一阶段连续高强度负责核心业务后，离开后我主动给自己留了一段休整期做系统复盘，把过去积累的业务方法论、数据拆解和团队协作 SOP 彻底沉淀了一遍，同时也持续跟踪行业最新趋势与 AI 提效工具。现在状态非常饱满，希望找一家重视长期价值的团队稳定深耕。`,
      },
      {
        style: '方向升级聚焦型',
        text: `之前在原岗位积累了完整的一线实战和拿结果经验；调整沉淀后我更明确下一阶段想聚焦在更贴合自己核心优势的业务方向里，把一套完整的打法长期做深做透，所以这段时间也在精挑真正同频的团队。`,
      },
    ],
    回应学历或跨类目追问: [
      {
        style: '硬核实战破格型（推荐）',
        text: `确实，我在学历/背景上不是传统最标准的履历，这点很坦诚。不过咱们这个岗位归根结底看的是实战拿结果的能力——过去我从一线做到能独立扛核心指标（可替换为你最亮眼的1~2个真实量化成果），这些实打实的操盘壁垒和避坑经验能帮团队立刻省下试错成本，恳请给一次面试交流的机会让我展示具体打法。`,
      },
      {
        style: '方法论迁移型',
        text: `虽然细分行业/品类略有差异，但底层的「用户需求洞察、核心漏斗数据归因、项目推进与转化提效」逻辑是高度相通的。我过往在高要求场景下跑通的成熟方法论迁移到贵司赛道，上手会非常快，我也已经提前研究了贵司的业务特点，期待细聊。`,
      },
    ],
    推进约面或体面婉拒: [
      {
        style: '积极锁约面时间型',
        text: `好的，非常期待进一步交流！我这边明天上午 10:00 后或下午 14:00-17:00 都方便，线上或线下面试都可以，您看哪个时间段业务负责人方便？我提前准备好过往项目的复盘资料。`,
      },
      {
        style: '高情商体面婉拒型',
        text: `非常感谢您的时间和详细介绍！综合评估了一下，目前这个岗位在作息/业务定位上与我现阶段的职业规划略有差异，为了不耽误贵司的招聘进度，这次就先不打扰了。祝团队早日找到合适人选，希望以后行业里还有合作交流的机会！`,
      },
    ],
  };

  const replies = map[scenario] || map['薪资试探与报价'];
  return {
    mode: 'quick',
    scenario,
    hrMessage,
    replies,
    tip: '以上为本地 0 秒生成的实战模板，如需完全贴合 HR 刚才发来的原话做针对性回复，可点击「模式 B 导出深度回复包」或「模式 A 生成」。',
  };
}

function buildChatReplyPrompt(job, scenario, hrMessage) {
  const { sanitized } = buildSanitizedContextForJob(job);
  const profile = loadPrivateProfile();
  const safeHrMsg = sanitizeText(hrMessage, profile).sanitizedText;
  const systemInstruction = `你是高情商、懂博弈心理的中文求职沟通与谈薪顾问。
HR/面试官刚刚发来一条消息，请结合候选人真实简历、目标岗位 JD 与当前场景（${scenario}），给出 3 版不同风格、可直接复制发送的高情商回复。
要求：
1. 严禁虚构简历中不存在的经历；语气自然像真人聊天（60~150字，不端着、不官腔）。
2. 帮候选人守住核心利益（双休、合理薪资、体面平等沟通），避免卑微讨好或生硬顶撞。
3. 必须只输出合法纯 JSON 对象（不要 Markdown 代码块包裹），字段严格如下：
{
  "analysis": "一句点破 HR 这句话背后的真实意图或潜台词（60字内）",
  "replies": [
    { "style": "稳重专业型", "text": "可直接复制的回复话术" },
    { "style": "高情商反问/推进型", "text": "可直接复制的回复话术" },
    { "style": "坚守底线型", "text": "可直接复制的回复话术" }
  ]
}`;

  const userPrompt = `当前沟通场景：${scenario}\nHR/面试官原话：${safeHrMsg}\n\n候选人脱敏简历与岗位信息：\n${sanitized.sanitizedText}`;
  return { systemInstruction, userPrompt, sanitized };
}

export async function runApiChatReply(jobId, { scenario, hrMessage }) {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);
  const { systemInstruction, userPrompt, sanitized } = buildChatReplyPrompt(job, scenario, hrMessage);
  const parsed = await callOfficialApiJson({ jobId: job.id, systemInstruction, userPrompt, sanitized });
  const profile = loadPrivateProfile();
  const restored = restoreObjectDeep(parsed, profile);

  createCoachSession({
    jobId: job.id,
    sessionType: 'chat_reply',
    persona: scenario,
    messages: [
      { role: 'hr', text: hrMessage, createdAt: new Date().toISOString() },
      {
        role: 'coach',
        analysis: restored.analysis || '',
        replies: restored.replies || [],
        createdAt: new Date().toISOString(),
      },
    ],
  });

  return {
    mode: 'api',
    analysis: restored.analysis || '',
    replies: restored.replies || [],
    privacyReport: {
      replacementsCount: sanitized.replacementsCount,
      hitFields: sanitized.hitFields,
    },
  };
}

export function exportChatReplyCollab(jobId, { scenario, hrMessage }) {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);
  if (!String(hrMessage || '').trim()) throw new Error('请先粘贴 HR 或面试官发来的原话。');
  ensureDataDirs();

  const { systemInstruction, userPrompt, sanitized } = buildChatReplyPrompt(job, scenario, hrMessage);
  const taskPath = path.join(PATHS.tasksDir, `task_chat_reply_job_${job.id}.md`);
  const resultPath = path.join(PATHS.tasksDir, `result_chat_reply_job_${job.id}.json`);

  const content = `# 脱敏聊天与谈薪回复任务（岗位 ID: ${job.id}，场景: ${scenario}）

> 本文件已经过本地隐私脱敏（命中替换 ${sanitized.replacementsCount} 处：${sanitized.hitFields.join('、') || '无敏感命中'}）。
> 把此文件路径发给 Antigravity，生成 JSON 保存到：\`${resultPath}\`

## 任务指令
${systemInstruction}

## 脱敏输入数据
${userPrompt}
`;

  fs.writeFileSync(taskPath, content, 'utf8');
  addAuditLog({
    jobId: job.id,
    mode: 'collab',
    provider: 'local-collab-chat-reply',
    replacementsCount: sanitized.replacementsCount,
    hitFields: sanitized.hitFields,
    sanitizedPreview: sanitized.sanitizedText,
  });

  return {
    mode: 'collab',
    taskPath,
    expectedResultPath: resultPath,
    promptText: `${systemInstruction}\n\n${userPrompt}`,
    privacyReport: {
      replacementsCount: sanitized.replacementsCount,
      hitFields: sanitized.hitFields,
    },
  };
}

export function importChatReplyCollab(jobId, { scenario = '聊天回复', hrMessage = '', resultText = null } = {}) {
  const resultPath = path.join(PATHS.tasksDir, `result_chat_reply_job_${jobId}.json`);
  let payload = resultText;
  if (!payload) {
    if (!fs.existsSync(resultPath)) {
      throw new Error(`未找到聊天回复结果文件：${resultPath}，请先让 Antigravity 写入该文件或粘贴 JSON。`);
    }
    payload = fs.readFileSync(resultPath, 'utf8');
  }
  const parsed = typeof payload === 'string' ? extractJsonObject(payload) : payload;
  const profile = loadPrivateProfile();
  const restored = restoreObjectDeep(parsed, profile);

  createCoachSession({
    jobId: Number(jobId),
    sessionType: 'chat_reply',
    persona: scenario,
    messages: [
      { role: 'hr', text: hrMessage, createdAt: new Date().toISOString() },
      {
        role: 'coach',
        analysis: restored.analysis || '',
        replies: restored.replies || [],
        createdAt: new Date().toISOString(),
      },
    ],
  });

  return {
    analysis: restored.analysis || '',
    replies: restored.replies || [],
  };
}

/**
 * 纯本地离线谈薪策略计算器 + 6 大高频压薪见招拆招剧本
 */
export function buildSalaryStrategy(plan = {}, job = null) {
  const parseJobSalaryRange = (str) => {
    const m = String(str || '').match(/(\d+(?:\.\d+)?)\s*[-~～]\s*(\d+(?:\.\d+)?)\s*[kK]/);
    if (!m) return { min: 15, max: 25 };
    return { min: Number(m[1]), max: Number(m[2]) };
  };

  const range = parseJobSalaryRange(job?.salary);
  const currentMonthlyK = Number(plan.currentMonthlyK) > 0 ? Number(plan.currentMonthlyK) : 0;
  const targetMonthlyK =
    Number(plan.targetMonthlyK) > 0
      ? Number(plan.targetMonthlyK)
      : Math.round((range.min + range.max) / 2);
  const floorMonthlyK =
    Number(plan.floorMonthlyK) > 0
      ? Number(plan.floorMonthlyK)
      : Math.max(12, Math.round(targetMonthlyK * 0.85));
  const months = Number(plan.months) >= 12 ? Number(plan.months) : 13;
  const performanceRatio =
    Number.isFinite(Number(plan.performanceRatio)) && Number(plan.performanceRatio) >= 0
      ? Math.min(60, Math.max(0, Number(plan.performanceRatio)))
      : 20;

  // 锚定开价：目标价上浮约 12%~15%，留出 10% 谈判缓冲空间
  const anchorMonthlyK =
    Number(plan.anchorMonthlyK) > 0
      ? Number(plan.anchorMonthlyK)
      : Math.max(targetMonthlyK + 2, Math.round(targetMonthlyK * 1.15));

  const fixedRatio = (100 - performanceRatio) / 100;
  const guaranteedMonthlyK = Number((targetMonthlyK * fixedRatio).toFixed(1));
  const annualTargetW = Number(((targetMonthlyK * months) / 10).toFixed(1));
  const annualFloorW = Number(((floorMonthlyK * months) / 10).toFixed(1));
  const annualAnchorW = Number(((anchorMonthlyK * months) / 10).toFixed(1));

  const playbooks = [
    {
      title: '1. HR 一上来就问：“你期望薪资多少？”',
      tactic: '先探底再锚定，给出「略高于目标价的紧凑区间」，别报过宽区间（否则对方只听最低值）。',
      script: `“我更看重岗位权责和增长空间。结合我过往操盘体量和团队经验，如果咱们是 ${months} 薪结构，我期望月薪在 ${targetMonthlyK}K - ${anchorMonthlyK}K 左右（年包约 ${annualTargetW}万 - ${annualAnchorW}万）。也想先了解下咱们这个岗位的定薪区间和绩效结构？”`,
    },
    {
      title: '2. HR 压价：“你期望超预算了，只能给到 XX K”',
      tactic: '不直接说行或不行，用「确定性价值 + 拆解补偿项」把谈判拉回你的目标线。',
      script: `“我理解预算限制。如果固定月薪暂时到不了 ${targetMonthlyK}K，咱们看能不能分两部分解决：第一，固定月薪尽量往 ${Math.max(floorMonthlyK, targetMonthlyK - 1)}K 靠（不低于我的底线 ${floorMonthlyK}K）；第二，把差额放到季度大促超额达成奖金或入职半年复核调薪机制里，我用明确 GMV/ROI 业绩换增量。”`,
    },
    {
      title: '3. HR 说：“我们底薪不高，但提成/绩效非常丰厚”',
      tactic: '警惕高画饼低保底！务必问清 3 个数字：固定保底是多少、团队平均达成率、提成基数是毛利还是 GMV。',
      script: `“我非常愿意拿结果说话。为了评估准确，方便告诉我目前这个岗位固定保底月薪大概占比多少（按目前 ${performanceRatio}% 绩效算保底约 ${guaranteedMonthlyK}K），以及团队里历史平均绩效系数大概能拿到几折、提成是按净成交额还是净利润算呢？”`,
    },
    {
      title: '4. HR 说：“试用期 3 个月，薪资打八折”',
      tactic: '成熟候选人入职即产出，优先争取全薪，次优争取缩短试用期或写明提前转正条件。',
      script: `“因为我属于直接上手的成熟人选，入职第一个月就能快速切入核心业务做诊断和优化。咱们能不能申请试用期全薪？如果公司制度卡得死，能不能约定 1~2 个月达到明确核心指标就提前转正？”`,
    },
    {
      title: '5. HR 追问上家精确薪资或拿空窗期/学历压价',
      tactic: '报“综合年包”不纠结单一底薪，把话题拉回“能为新公司省多少试错成本、赚多少增量”。',
      script: `“上家整体是底薪加项目/业绩激励的综合包，换工作时我更看重当前岗位的市场价值和我能带来的确定性产出。过去几年我在同类核心岗位上跑通了完整闭环并带出过明确增量，能直接帮咱们少交试错和招人学费，其实综合人效成本反而更低。”`,
    },
    {
      title: '6. 口头 Offer 确认前必须落纸的 5 个核验点',
      tactic: '口头答应不算数，发正式 Offer 前逐项确认清楚，避免入职踩雷。',
      script: `“非常开心能加入团队！在正式签字前，方便在 Offer 邮件里帮忙把这几项写清楚吗：① 税前月薪拆分（基本工资+绩效占比）及试用期薪资；② 发放月数及年终奖计算口径；③ 明确周末双休作息；④ 五险一金缴纳基数和比例；⑤ 入职日期与汇报对象。”`,
    },
  ];

  return {
    plan: {
      currentMonthlyK,
      targetMonthlyK,
      floorMonthlyK,
      anchorMonthlyK,
      months,
      performanceRatio,
      guaranteedMonthlyK,
      annualTargetW,
      annualFloorW,
      annualAnchorW,
      strategyNotes: String(plan.strategyNotes || ''),
    },
    jobRange: range,
    playbooks,
  };
}

export function getCoachBundle(jobId, templateIdOverride = '') {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);
  const prep = getInterviewPrep(jobId);
  const mockSessions = listCoachSessions(jobId, 'mock_interview');
  const chatSessions = listCoachSessions(jobId, 'chat_reply').slice(0, 10);
  const salary = buildSalaryStrategy(prep.salary_plan, job);
  const activeTemplate = templateIdOverride
    ? getRoleTemplateById(templateIdOverride)
    : prep.salary_plan?.templateId
      ? getRoleTemplateById(prep.salary_plan.templateId)
      : detectRoleTemplate(job.title, job.jd_text);

  return {
    job,
    prep,
    mockSessions,
    chatSessions,
    salary,
    roleTemplate: {
      id: activeTemplate.id,
      group: activeTemplate.group || '通用',
      name: activeTemplate.name,
      salaryStructure: activeTemplate.salaryStructure,
      builtInCount: getFullQuestionsForTemplate(activeTemplate.id).length,
    },
    allTemplates: ROLE_TEMPLATES.map((t) => ({
      id: t.id,
      group: t.group || '通用',
      name: t.name,
      builtInCount: getFullQuestionsForTemplate(t.id).length,
    })),
    careerStages: CAREER_STAGES,
    reverseChecklist: buildFullReverseChecklist(activeTemplate.id),
    universalSalaryTraps: UNIVERSAL_SALARY_TRAPS,
  };
}
