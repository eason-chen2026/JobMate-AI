import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDataDirs } from './paths.mjs';
import { addAuditLog, getJobById, updateJob } from './db.mjs';
import {
  loadLocalConfig,
  loadMasterResume,
  loadPrivateProfile,
  restoreObjectDeep,
  sanitizeText,
} from './privacy.mjs';

/**
 * 组装发送给大模型的脱敏提示词（两种模式共用同一套高质量指令）
 */
export function buildSanitizedPromptBundle(job) {
  const profile = loadPrivateProfile();
  const config = loadLocalConfig();
  const masterResume = loadMasterResume();

  const rawPayload = {
    preferences: config.targetPreferences,
    masterResume,
    targetJob: {
      id: job.id,
      platform: job.platform,
      company: job.company,
      title: job.title,
      city: job.city,
      salary: job.salary,
      jd_text: job.jd_text,
    },
  };

  const sanitized = sanitizeText(JSON.stringify(rawPayload, null, 2), profile);

  const systemInstruction = `你是严谨的中文资深招聘顾问与简历优化专家。
必须遵守以下铁律：
1. 严禁虚构任何候选人未拥有的工作经历、项目、学历、年限或数据；只能在“主简历”已有事实基础上重排顺序、突出与 JD 最匹配的表述、对齐关键词。
2. 保留输入中的脱敏占位符（如 {{SENSITIVE_1}} 等），不要猜测或补全真实隐私信息。
3. 必须只输出合法的纯 JSON 对象（不要用 Markdown 代码块包裹，不要输出额外解释），字段严格如下：
{
  "match_score": 0到100的整数,
  "match_summary": "100字以内客观匹配结论",
  "risk_flags": ["识别到的避坑风险点，如外包/单休/要求与薪资倒挂/JD模糊等，没有则空数组"],
  "missing_skills": ["JD要求但主简历未明确体现的技能关键词"],
  "tailored_resume": {
    "headline": "贴合该岗位的求职定位标题",
    "basicInfo": "一句话基本信息（保留主简历中的原样，如性别/年龄/学历/经验年限，不要填入隐私联系方式）",
    "summary": "针对该岗位重写的个人优势要点（2~4条，用 \\n 换行分隔，每条带量化成果）",
    "skills": ["按与该JD相关性从高到低排序的核心能力分组（支持 分类名：技能A｜技能B 格式）"],
    "experiences": [
      {
        "company": "公司名称（保持原样或原占位符）",
        "role": "职位",
        "period": "时间段",
        "highlights": ["紧贴JD关键词润色重排后的公司级成果要点（若全部按 subProjects 展开可为空数组）"],
        "subProjects": [
          {
            "name": "该公司下负责的品牌或子项目名称（如主简历有此层级必须保留，不要拆成独立公司）",
            "role": "项目角色/职位",
            "period": "时间段",
            "highlights": ["紧贴JD关键词润色重排后的子项目成果要点"]
          }
        ]
      }
    ],
    "projects": [
      {
        "name": "独立重点项目名称（已在 experiences[].subProjects 中的无需重复）",
        "role": "角色",
        "period": "时间段",
        "highlights": ["突出与目标岗位相关的业务价值与数据成果"]
      }
    ],
    "education": [
      { "school": "学校", "degree": "学历与专业", "period": "时间" }
    ]
  },
  "greetings": [
    {
      "style": "直给成果型",
      "text": "适合Boss直聘的150~210字打招呼语：先亮年限和核心匹配点，再给1~2个量化成果，最后自然收尾邀看简历"
    },
    {
      "style": "业务痛点切入型",
      "text": "适合Boss直聘的150~210字打招呼语：紧扣JD业务场景切入，说明自己做过类似落地并表达交流意愿"
    }
  ]
}`;

  const userPrompt = `请根据以下已脱敏的求职偏好、主简历与目标岗位 JD，输出标准 JSON：\n\n${sanitized.sanitizedText}`;

  return {
    systemInstruction,
    userPrompt,
    sanitized,
  };
}

function extractJsonObject(rawText) {
  const trimmed = String(rawText || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return JSON.parse(fenced[1].trim());
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('模型返回内容无法解析为合法 JSON，请检查输出格式。');
  }
}

/**
 * 校验并写回定制结果到数据库（自动将占位符在本地还原，供 PDF 生成和人工发送）
 */
export function applyAnalysisResult(jobId, rawResult) {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);

  const parsed = typeof rawResult === 'string' ? extractJsonObject(rawResult) : rawResult;
  const profile = loadPrivateProfile();
  const restored = restoreObjectDeep(parsed, profile);

  const greetings = Array.isArray(restored.greetings)
    ? restored.greetings
        .filter((g) => g && g.text)
        .map((g) => ({
          style: String(g.style || '默认风格').trim(),
          text: String(g.text).trim(),
        }))
    : [];

  const firstGreeting = greetings[0] || { style: '', text: '' };

  return updateJob(jobId, {
    match_score: Number.isFinite(Number(restored.match_score))
      ? Math.max(0, Math.min(100, Math.round(Number(restored.match_score))))
      : null,
    match_summary: String(restored.match_summary || ''),
    risk_flags: Array.isArray(restored.risk_flags) ? restored.risk_flags : [],
    missing_skills: Array.isArray(restored.missing_skills) ? restored.missing_skills : [],
    tailored_resume: restored.tailored_resume || null,
    greetings,
    selected_greeting: job.selected_greeting || firstGreeting.text,
    greeting_style: job.greeting_style || firstGreeting.style,
    status: job.status === 'new' ? 'ready' : job.status,
  });
}

/**
 * 模式 A：直连官方 API（Gemini / DeepSeek / OpenAI 兼容官方接口）
 */
export async function runApiAnalysis(jobId) {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);

  const config = loadLocalConfig();
  if (!config.apiKey) {
    throw new Error('当前未配置官方 API Key。你可以在“设置”中填入官方 Key，或切换到“零 API 协作模式”。');
  }

  const { systemInstruction, userPrompt, sanitized } = buildSanitizedPromptBundle(job);

  // 先记录外发审计日志，确保每次请求完全透明可查
  addAuditLog({
    jobId: job.id,
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
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json',
        },
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`Gemini API 调用失败 (${resp.status}): ${data?.error?.message || JSON.stringify(data)}`);
    }
    rawResponseText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } else {
    // DeepSeek 官方或 OpenAI 兼容官方接口
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
        temperature: 0.3,
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

  const updatedJob = applyAnalysisResult(jobId, rawResponseText);
  return {
    mode: 'api',
    job: updatedJob,
    privacyReport: {
      replacementsCount: sanitized.replacementsCount,
      hitFields: sanitized.hitFields,
    },
  };
}

/**
 * 模式 B：零 API Key 本地协作模式（导出脱敏任务包，供 Antigravity 对话直接处理）
 */
export function exportCollabTask(jobId) {
  const job = getJobById(jobId);
  if (!job) throw new Error(`未找到 ID=${jobId} 的岗位`);

  ensureDataDirs();
  const { systemInstruction, userPrompt, sanitized } = buildSanitizedPromptBundle(job);

  const taskPath = path.join(PATHS.tasksDir, `task_job_${job.id}.md`);
  const resultPath = path.join(PATHS.tasksDir, `result_job_${job.id}.json`);

  const content = `# 脱敏求职定制任务（岗位 ID: ${job.id}）

> 本文件已经过本地隐私脱敏（命中替换 ${sanitized.replacementsCount} 处：${sanitized.hitFields.join('、') || '无敏感命中'}），不含真实姓名、手机号、邮箱与微信号。
> 你可以直接把此文件路径发给 Antigravity，让其按要求生成 JSON 并保存到：\`${resultPath}\`

## 任务指令
${systemInstruction}

## 脱敏输入数据
${userPrompt}
`;

  fs.writeFileSync(taskPath, content, 'utf8');

  addAuditLog({
    jobId: job.id,
    mode: 'collab',
    provider: 'local-collab-task',
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

/**
 * 模式 B：从本地 result_job_<id>.json 文件或粘贴 JSON 导入分析结果
 */
export function importCollabTaskResult(jobId, jsonTextOrObj = null) {
  const resultPath = path.join(PATHS.tasksDir, `result_job_${jobId}.json`);
  let payload = jsonTextOrObj;
  if (!payload) {
    if (!fs.existsSync(resultPath)) {
      throw new Error(`未找到协作结果文件：${resultPath}，请先粘贴 JSON 或让助手写入该文件。`);
    }
    payload = fs.readFileSync(resultPath, 'utf8');
  }
  return applyAnalysisResult(jobId, payload);
}
