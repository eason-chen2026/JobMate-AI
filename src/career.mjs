import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDataDirs } from './paths.mjs';
import {
  addAuditLog,
  buildReviewStats,
  createCareerPlan,
  getCareerPlanById,
  listCareerPlans,
  updateCareerPlan,
} from './db.mjs';
import {
  loadLocalConfig,
  loadMasterResume,
  loadPrivateProfile,
  restoreObjectDeep,
  sanitizeText,
} from './privacy.mjs';
import { CAREER_STAGES, ROLE_TEMPLATES, detectRoleTemplate } from './role-templates.mjs';

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
    throw new Error('规划结果无法解析为合法 JSON，请检查格式。');
  }
}

async function callOfficialApiJson({ systemInstruction, userPrompt, sanitized }) {
  const config = loadLocalConfig();
  if (!config.apiKey) {
    throw new Error('当前未配置官方 API Key。你可以在「隐私与 AI 设置」填入 Key，或使用模式 B 导出脱敏规划任务包。');
  }

  addAuditLog({
    jobId: null,
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

function normalizeCareerPlanData(raw = {}) {
  return {
    headline: String(raw?.headline || '').trim(),
    positioning_summary: String(raw?.positioning_summary || '').trim(),
    current_strengths: Array.isArray(raw?.current_strengths)
      ? raw.current_strengths.map((s) => String(s || '').trim()).filter(Boolean)
      : [],
    recommended_directions: Array.isArray(raw?.recommended_directions)
      ? raw.recommended_directions
          .filter((d) => d && d.direction)
          .map((d) => ({
            track: String(d.track || '推荐方向').trim(),
            direction: String(d.direction || '').trim(),
            target_titles: Array.isArray(d.target_titles) ? d.target_titles.map(String) : [],
            salary_range: String(d.salary_range || '').trim(),
            why_fit: String(d.why_fit || '').trim(),
            challenges: String(d.challenges || '').trim(),
            first_step: String(d.first_step || '').trim(),
          }))
      : [],
    skill_gaps: Array.isArray(raw?.skill_gaps)
      ? raw.skill_gaps
          .filter((g) => g && g.skill)
          .map((g, idx) => ({
            id: String(g.id || `gap_${idx + 1}`),
            priority: String(g.priority || 'P0').trim(),
            skill: String(g.skill || '').trim(),
            why_needed: String(g.why_needed || '').trim(),
            practice_method: String(g.practice_method || '').trim(),
            deliverable: String(g.deliverable || '').trim(),
            estimated_time: String(g.estimated_time || '1-2周').trim(),
            done: Boolean(g.done),
          }))
      : [],
    roadmap: Array.isArray(raw?.roadmap)
      ? raw.roadmap
          .filter((r) => r && r.phase)
          .map((r, idx) => ({
            id: String(r.id || `phase_${idx + 1}`),
            phase: String(r.phase || '').trim(),
            goal: String(r.goal || '').trim(),
            actions: Array.isArray(r.actions)
              ? r.actions.map((a, aIdx) =>
                  typeof a === 'string'
                    ? { id: `act_${idx}_${aIdx}`, text: a.trim(), done: false }
                    : { id: String(a?.id || `act_${idx}_${aIdx}`), text: String(a?.text || '').trim(), done: Boolean(a?.done) }
                )
              : [],
          }))
      : [],
  };
}

/**
 * 纯本地离线快速诊断（0 秒立即可用，支持应届生 / 社招 / 管理者，支持未知方向与指定岗位）
 */
export function generateQuickCareerPlan({
  planType = 'skill_upgrade',
  careerStage = 'mid_career',
  targetRole = '',
  interests = '',
  constraints = '',
} = {}) {
  const resume = loadMasterResume();
  const review = buildReviewStats();
  const stageInfo = CAREER_STAGES.find((s) => s.id === careerStage) || CAREER_STAGES[1];
  const matchedTpl = detectRoleTemplate(targetRole || resume.headline || interests, resume.summary || '');
  const topMissing = (review.topMissingSkills || []).map((x) => x.skill);

  const currentStrengths = [
    ...(resume.skills || []).slice(0, 5),
    resume.headline ? `现有主定位：${resume.headline}` : '',
  ].filter(Boolean);

  const recommendedDirections =
    planType === 'explore'
      ? [
          {
            track: '稳妥深耕线（最高成功率）',
            direction: `围绕现有背景深耕「${matchedTpl.name}」核心岗位`,
            target_titles: [targetRole || resume.headline || matchedTpl.name, '高级专员 / 主管'],
            salary_range: careerStage === 'fresh_grad' ? '8K - 15K' : '15K - 28K',
            why_fit: `最直接变现你主简历已有的经历和技能积累，面试转化率最高。`,
            challenges: '同质化竞争较强，需要靠清晰的数据复盘案例或作品集拉开差距。',
            first_step: '先选 3~5 个中腰部优质公司投递试水，快速拿到市场反馈与面试高频题。',
          },
          {
            track: 'AI 提效赋能线（高成长红利）',
            direction: `结合自身行业经验切入「AI + 业务应用 / AI 运营 / AI 产品助理」`,
            target_titles: ['AI 业务应用专员/经理', 'AIGC 内容运营', 'AI 产品经理/项目经理'],
            salary_range: careerStage === 'fresh_grad' ? '10K - 18K' : '18K - 35K',
            why_fit: '当下几乎所有行业都在招“懂真实业务流程 + 会用 AI 降本增效”的复合型人才，非纯算法岗也能吃红利。',
            challenges: '不能只停留在会聊天，必须拿出 1~2 个用 AI 提效的真实工作流或作品案例。',
            first_step: '把自己过往最耗时的工作流程用 AI 工具跑通一套自动化模板，整理成 1 页作品集。',
          },
          {
            track: '跨界迁移 / 管理跃迁线',
            direction:
              careerStage === 'fresh_grad'
                ? '泛消费品 / 互联网综合运营、管培生或商业分析方向'
                : '从单一执行升级为项目负责人（PM）/ 跨类目甲方团队管理',
            target_titles:
              careerStage === 'fresh_grad'
                ? ['管培生', '运营专员', '项目助理']
                : ['项目经理（PM）', '业务负责人', '运营经理'],
            salary_range: careerStage === 'fresh_grad' ? '9K - 16K' : '20K - 35K+',
            why_fit: '把底层通用的数据分析、拆解推进和沟通协同能力迁移到毛利更高、增长更快的赛道。',
            challenges: '面试官会重点质疑行业跨度，需要提前准备“可迁移方法论 + 30天落地计划”。',
            first_step: '针对目标跨界赛道拆解 3 家头部公司公开案例，输出 1 份 2 页行业诊断文档带去面试。',
          },
        ]
      : [
          {
            track: '目标岗位聚焦',
            direction: targetRole || resume.headline || matchedTpl.name,
            target_titles: [targetRole || resume.headline || matchedTpl.name],
            salary_range: careerStage === 'fresh_grad' ? '8K - 16K' : '15K - 30K',
            why_fit: `聚焦单一目标岗位深挖 JD 高频要求，集中补齐前 3 项关键短板，短期提 Offer 效率最高。`,
            challenges: '需在面试中清晰回应经历差距，并用可验证的练习作品或复盘文档证明即战力。',
            first_step: '对照下方技能缺口清单，先攻克标 P0 的 2 项核心技能并写入面试案例。',
          },
        ];

  const skillGaps = [];
  topMissing.slice(0, 3).forEach((skill, idx) => {
    skillGaps.push({
      id: `gap_pool_${idx + 1}`,
      priority: 'P0',
      skill,
      why_needed: '在你的岗位池 JD 分析中高频出现，是目前简历与目标岗位之间的显性短板。',
      practice_method: `1. 找 3~5 个该技能的真实行业标杆案例拆解；2. 结合自己过往经历写 1 份从 0 到 1 的实操落地方案；3. 在「AI 模拟面试」里专门针对此项做 3 轮压力追问演练。`,
      deliverable: `产出 1 份《${skill} 实操拆解与落地 SOP（1~2页）》，面试时直接拿出来展示加分。`,
      estimated_time: '3~7天',
      done: false,
    });
  });

  if (skillGaps.length < 3) {
    const defaults =
      careerStage === 'fresh_grad'
        ? [
            {
              priority: 'P0',
              skill: '结构化作品集与 STAR 案例包装',
              why_needed: '应届生没有全职经历，作品集和清晰的项目复盘是打败 80% 竞争对手的最强抓手。',
              practice_method: '挑选 1~2 个校园/实习项目或针对心仪公司写一份竞品体验/业务诊断报告，严格按“痛点→调研→动作→结果”排版。',
              deliverable: '产出 1 份 3~5 页 PDF 求职作品集 / 目标公司分析报告。',
              estimated_time: '5~7天',
            },
            {
              priority: 'P0',
              skill: '数据分析与 AI 提效实战能力',
              why_needed: '几乎所有现代岗位都默认要求会看基础数据漏斗并善用 AI 工具提升 2~3 倍执行效率。',
              practice_method: '用 Excel/透视表练透目标岗位核心漏斗指标，同时用 AI 搭 1 个日常提效 Prompt 工作流记录前后耗时对比。',
              deliverable: '产出 1 套岗位核心指标分析模板 + 1 个 AI 提效实操演示案例。',
              estimated_time: '1周',
            },
            {
              priority: 'P1',
              skill: '目标岗位高频面试问答与职场沟通',
              why_needed: '避免面试紧张流水账，把学习潜力和执行可靠性清晰传达给面试官。',
              practice_method: '使用本工具「面试与谈薪实战」刷完本岗位模板题，并完成至少 3 场 AI 模拟面试录音复盘。',
              deliverable: '形成自己的《高频 10 问口语逐字稿》与 6 维度反问清单。',
              estimated_time: '3~5天',
            },
          ]
        : [
            {
              priority: 'P0',
              skill: '经营利润账与结构化数据归因能力',
              why_needed: '从执行岗跃迁到高薪骨干/负责人，老板最看重的不只是流水产出，而是 ROI、毛利与投入产出比。',
              practice_method: '拉出自己过往 1 个核心项目，重做一份包含成本拆解、核心漏斗转化率、异常诊断与优化结论的一页纸经营复盘。',
              deliverable: '产出 1 份脱敏版《核心项目经营复盘与增长方法论》。',
              estimated_time: '5天',
            },
            {
              priority: 'P0',
              skill: 'AI 工具融入本职工作流（复合竞争力）',
              why_needed: '同资历候选人中，能用 AI 批量做竞品调研、脚本/方案初稿和数据复盘的人议价权高出 20%+。',
              practice_method: '挑选日常最重复耗时的 2 个环节，设计固定 Prompt 模板与验收标准，实测效率提升幅度。',
              deliverable: '整理 2 个可直接讲给面试官听的“AI 降本增效实战案例”。',
              estimated_time: '1周',
            },
            {
              priority: 'P1',
              skill: '向上管理与跨部门推进复盘能力',
              why_needed: '中高级岗位 50% 的挑战在跨团队拿资源与对齐预期，是二面/终面高频拉分项。',
              practice_method: '复盘 2 次真实跨部门扯皮或资源紧张经历，提炼成“对齐共同目标→拿数据说话→拆 MVP 落地”的沟通话术。',
              deliverable: '完善 2 个跨部门协作与冲突化解的 STAR 面试故事。',
              estimated_time: '3天',
            },
          ];

    for (const d of defaults) {
      if (skillGaps.length >= 4) break;
      skillGaps.push({ id: `gap_def_${skillGaps.length + 1}`, ...d, done: false });
    }
  }

  const roadmap = [
    {
      id: 'phase_1',
      phase: '第 1 周：定位校准与核心资产打磨',
      goal: '明确主攻岗位边界，完成高转化主简历与 1 份代表作复盘文档',
      actions: [
        { id: 'a1_1', text: '在「主简历底稿」补齐全部量化成果与核心项目层级', done: false },
        { id: 'a1_2', text: '针对目标方向挑选 5~8 个中腰部练手岗位入库并生成定制 PDF', done: false },
        { id: 'a1_3', text: `完成 1 份针对「${skillGaps[0]?.skill || '核心短板'}」的实操拆解文档`, done: false },
      ],
    },
    {
      id: 'phase_2',
      phase: '第 2~3 周：实战投递、模拟演练与短板速补',
      goal: '通过首批面试验证市场反馈，用 AI 模拟面试把回答打磨到脱口而出',
      actions: [
        { id: 'a2_1', text: '在黄金时段（工作日 09:30-11:00）分批投递并在「复盘看板」追踪已读/回复率', done: false },
        { id: 'a2_2', text: '针对每个约面岗位刷完 12 题预测题库，完成至少 2 轮压力模拟面试', done: false },
        { id: 'a2_3', text: '每次真实面试后在岗位备注记录被问倒的问题，当天补齐答案', done: false },
      ],
    },
    {
      id: 'phase_3',
      phase: '第 4 周及以后：冲刺理想目标与谈薪定 Offer',
      goal: '拿稳保底 Offer 后集中冲刺心仪高薪公司，体面谈下理想年包',
      actions: [
        { id: 'a3_1', text: '复盘前几场面试表现，优化简历关键词与开场自我介绍', done: false },
        { id: 'a3_2', text: '启动心仪头部/高薪目标公司投递，并提前用「谈薪计算器」定好开价锚点与底线', done: false },
        { id: 'a3_3', text: '终面用「6 维度反问清单」核实双休、社保基数与真实绩效口径后稳健签约', done: false },
      ],
    },
  ];

  const planData = normalizeCareerPlanData({
    headline:
      planType === 'explore'
        ? `${stageInfo.label} · 职业方向定位与成长蓝图`
        : `${targetRole || matchedTpl.name} · 技能缺口诊断与练习提升方案`,
    positioning_summary: `${stageInfo.summary}${interests ? ` 结合你关注的兴趣/方向（${interests}）` : ''}${constraints ? `及个人条件限制（${constraints}）` : ''}，已为你先生成一份 0 秒离线快速规划；点击「模式 B 导出深度规划包」或「模式 A 生成」可获得完全贴合你每段经历的深度定制版。`,
    current_strengths: currentStrengths,
    recommended_directions: recommendedDirections,
    skill_gaps: skillGaps,
    roadmap,
  });

  return createCareerPlan({
    planType,
    careerStage,
    targetRole: targetRole || matchedTpl.name,
    userInput: { planType, careerStage, targetRole, interests, constraints },
    plan: planData,
  });
}

function buildCareerPromptBundle({ planType, careerStage, targetRole, interests, constraints }) {
  const profile = loadPrivateProfile();
  const resume = loadMasterResume();
  const review = buildReviewStats();
  const stageInfo = CAREER_STAGES.find((s) => s.id === careerStage) || CAREER_STAGES[1];

  const rawPayload = {
    planType: planType === 'explore' ? '不知道找什么岗位：需要职业方向定位与多路线推荐' : '已有目标岗位：需要技能缺口深度诊断与可练习补强方案',
    careerStage: stageInfo,
    targetRole: targetRole || '待探索',
    userInterests: interests || '',
    userConstraints: constraints || '',
    masterResume: resume,
    jobPoolMissingSkills: review.topMissingSkills || [],
  };

  const sanitized = sanitizeText(JSON.stringify(rawPayload, null, 2), profile);

  const systemInstruction = `你是顶级中文职业规划师、行业资深招聘专家与技能成长教练，擅长辅导从「应届大学生」到「社招骨干/管理者」以及「AI 转型」的各类求职者。
必须遵守以下铁律：
1. 100% 立足候选人真实背景、学历、阶段与个人偏好，拒绝空洞鸡汤和假大空建议；所有技能补强方案必须落到「具体怎么练、产出什么可展示作品/复盘、预计花几天」。
2. 保留输入中的脱敏占位符（如 {{SENSITIVE_1}}），不要猜测隐私信息。
3. 必须只输出合法纯 JSON 对象（不要 Markdown 代码块包裹），字段严格如下：
{
  "headline": "本次职业规划标题（简明有力）",
  "positioning_summary": "150~260字客观定位诊断：点出候选人当下最值钱的核心壁垒、当前阶段的真实机会点与最大盲区",
  "current_strengths": ["已掌握且可直接变现的核心能力1", "能力2", "能力3", "能力4"],
  "recommended_directions": [
    {
      "track": "路线标签（如：稳妥深耕线 / 高薪跃迁线 / AI赋能跨界线）",
      "direction": "具体方向名称",
      "target_titles": ["可搜索投递的具体岗位名称1", "岗位名称2"],
      "salary_range": "合理薪资区间参考",
      "why_fit": "为什么适合候选人（结合真实经历说明）",
      "challenges": "该方向的主要门槛或风险",
      "first_step": "本周立刻可做的第一步验证动作"
    }
  ],
  "skill_gaps": [
    {
      "id": "gap_1",
      "priority": "P0 或 P1",
      "skill": "需要补充或升级的具体技能名称",
      "why_needed": "为什么目标岗位非常看重这项能力",
      "practice_method": "非常具体的实操练习步骤（100~180字，教用户不花冤枉钱自己怎么练到位）",
      "deliverable": "练完后应该产出的具体作品集/SOP/复盘文档（能直接带去面试加分）",
      "estimated_time": "预计投入周期（如 5天 / 2周）"
    }
  ],
  "roadmap": [
    {
      "id": "phase_1",
      "phase": "阶段标题（如：第1-2周：定位校准与核心短板突击）",
      "goal": "本阶段要拿到的具体结果",
      "actions": ["具体可勾选执行动作1", "具体动作2", "具体动作3"]
    }
  ]
}`;

  const userPrompt = `请根据以下已脱敏的候选人背景、所处阶段与目标诉求，生成专业、可落地的职业规划与技能练习提升方案：\n\n${sanitized.sanitizedText}`;
  return { systemInstruction, userPrompt, sanitized };
}

export async function runApiCareerPlan(input) {
  const { systemInstruction, userPrompt, sanitized } = buildCareerPromptBundle(input);
  const parsed = await callOfficialApiJson({ systemInstruction, userPrompt, sanitized });
  const profile = loadPrivateProfile();
  const restored = restoreObjectDeep(parsed, profile);
  const record = createCareerPlan({
    planType: input.planType || 'skill_upgrade',
    careerStage: input.careerStage || 'mid_career',
    targetRole: input.targetRole || '',
    userInput: input,
    plan: normalizeCareerPlanData(restored),
  });
  return {
    mode: 'api',
    careerPlan: record,
    privacyReport: {
      replacementsCount: sanitized.replacementsCount,
      hitFields: sanitized.hitFields,
    },
  };
}

export function exportCareerPlanCollab(input) {
  ensureDataDirs();
  const { systemInstruction, userPrompt, sanitized } = buildCareerPromptBundle(input);
  const taskPath = path.join(PATHS.tasksDir, 'task_career_plan.md');
  const resultPath = path.join(PATHS.tasksDir, 'result_career_plan.json');

  const content = `# 脱敏职业规划与技能提升任务（模式 B）

> 本文件已经过本地隐私脱敏（命中替换 ${sanitized.replacementsCount} 处：${sanitized.hitFields.join('、') || '无敏感命中'}）。
> 把此文件路径发给 Antigravity，生成 JSON 保存到：\`${resultPath}\`

## 任务指令
${systemInstruction}

## 脱敏输入数据
${userPrompt}
`;

  fs.writeFileSync(taskPath, content, 'utf8');
  addAuditLog({
    jobId: null,
    mode: 'collab',
    provider: 'local-collab-career-plan',
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

export function importCareerPlanCollab(input = {}, resultTextOrObj = null) {
  const resultPath = path.join(PATHS.tasksDir, 'result_career_plan.json');
  let payload = resultTextOrObj;
  if (!payload) {
    if (!fs.existsSync(resultPath)) {
      throw new Error(`未找到职业规划结果文件：${resultPath}，请先让 Antigravity 写入该文件或粘贴 JSON。`);
    }
    payload = fs.readFileSync(resultPath, 'utf8');
  }
  const parsed = typeof payload === 'string' ? extractJsonObject(payload) : payload;
  const profile = loadPrivateProfile();
  const restored = restoreObjectDeep(parsed, profile);

  return createCareerPlan({
    planType: input.planType || 'skill_upgrade',
    careerStage: input.careerStage || 'mid_career',
    targetRole: input.targetRole || restored.headline || '',
    userInput: input,
    plan: normalizeCareerPlanData(restored),
  });
}

export function getCareerState() {
  return {
    stages: CAREER_STAGES,
    templates: ROLE_TEMPLATES.map((t) => ({ id: t.id, name: t.name })),
    plans: listCareerPlans(20),
  };
}

export function patchCareerPlanProgress(planId, planData) {
  const existing = getCareerPlanById(planId);
  if (!existing) throw new Error(`未找到 ID=${planId} 的职业规划`);
  return updateCareerPlan(planId, { plan: normalizeCareerPlanData(planData) });
}
