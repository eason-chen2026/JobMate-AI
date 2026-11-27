import { createJob, getJobById, listJobs, updateJob, addAuditLog } from './db.mjs';
import {
  loadLocalConfig,
  loadMasterResume,
  loadPrivateProfile,
  sanitizeText,
} from './privacy.mjs';
import { runApiAnalysis } from './ai.mjs';
import { applyRoleTemplateToJob } from './coach.mjs';
import { detectRoleTemplate } from './role-templates.mjs';
import { generateJobResumePdf } from './pdf.mjs';

export const TIER_META = {
  practice: {
    id: 'practice',
    label: '练手训练',
    badge: '面试热身 · 刷手感',
    desc: '门槛友好、匹配度高，适合先约面测试表达节奏、摸底行情并打磨话术。',
  },
  core: {
    id: 'core',
    label: '主力匹配',
    badge: '核心冲 Offer',
    desc: '与你过往经历、核心技能和期望薪资高度契合的黄金主攻岗位。',
  },
  stretch: {
    id: 'stretch',
    label: '进阶挑战',
    badge: '跃迁冲刺 · 高回报',
    desc: '薪资更高一档、大平台或更高职级，适合用核心量化成果争取破格跃迁。',
  },
};

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析薪资文本为月薪区间（单位：K）
 */
export function parseSalaryRangeK(salaryText) {
  const s = String(salaryText || '').replace(/,/g, '').trim();
  if (!s || /面议|保密/.test(s)) return null;

  // 15-25k / 15K-25K·14薪 / 1.5-2.5万
  let m = s.match(/(\d+(?:\.\d+)?)\s*[-~～至]\s*(\d+(?:\.\d+)?)\s*[kK千]/);
  if (m) return { min: Number(m[1]), max: Number(m[2]), mid: (Number(m[1]) + Number(m[2])) / 2 };

  m = s.match(/(\d+(?:\.\d+)?)\s*[-~～至]\s*(\d+(?:\.\d+)?)\s*万/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // 判断是月薪万（如 1.5-2.5万）还是年薪万（如 25-40万/年）
    const isAnnual = /年|\/年/.test(s) || a >= 10;
    const min = isAnnual ? Number(((a * 10) / 12).toFixed(1)) : a * 10;
    const max = isAnnual ? Number(((b * 10) / 12).toFixed(1)) : b * 10;
    return { min, max, mid: (min + max) / 2 };
  }

  m = s.match(/(\d{4,5})\s*[-~～至]\s*(\d{4,5})/);
  if (m) {
    const min = Number((Number(m[1]) / 1000).toFixed(1));
    const max = Number((Number(m[2]) / 1000).toFixed(1));
    return { min, max, mid: (min + max) / 2 };
  }

  m = s.match(/(\d+(?:\.\d+)?)\s*[kK千]/);
  if (m) {
    const v = Number(m[1]);
    return { min: v, max: v, mid: v };
  }

  return null;
}

// 13 大行业模板对应的招聘聚合站高命中标准短词（全行业通用，避免长复合职位名搜出 0 结果）
const TEMPLATE_SEARCH_QUERIES = {
  ai_role: ['AI产品经理', '大模型算法', 'AI应用开发', '人工智能'],
  tech_dev: ['前端开发', 'Java开发', '后端开发', '全栈开发'],
  data_analyst: ['数据分析师', '商业分析', 'BI数据', '数据运营'],
  product_ops: ['产品经理', '用户运营', '增长运营', '电商运营'],
  design_creative: ['UI设计师', '视觉设计', '平面设计', '视频剪辑'],
  new_media_ops: ['新媒体运营', '小红书运营', '短视频运营', '内容运营'],
  sales_bd: ['大客户销售', '商务拓展', 'BD经理', '渠道销售'],
  douyin_live_lead: ['抖音运营', '直播运营', '电商运营', '直播间运营'],
  live_host: ['带货主播', '电商主播', '直播主播', '场控中控'],
  hr_admin: ['HRBP', '招聘主管', '人事行政', '人力资源'],
  finance_legal: ['财务会计', '财务分析', '法务专员', '审计'],
  fresh_grad_general: ['管培生', '运营专员', '产品助理', '应届生'],
  universal_career: ['项目经理', '运营经理', '业务主管', '产品经理'],
};

const KNOWN_SHORT_ROLES = [
  '直播运营', '抖音运营', '电商运营', '品牌运营', '新媒体运营', '内容运营', '用户运营', '增长运营', '跨境运营',
  '带货主播', '电商主播', '产品经理', 'AI产品经理', '前端开发', '后端开发', 'Java开发', '全栈开发', '测试开发',
  '数据分析', '商业分析', 'UI设计', '视觉设计', '平面设计', '视频剪辑', '大客户销售', '商务拓展', '渠道销售',
  '人力资源', 'HRBP', '招聘主管', '财务会计', '法务专员', '项目经理', '运营总监', '运营负责人', '直播负责人', '管培生',
];

function buildHighHitQueries(primaryKeyword, secondaryKeyword, roleParts, templateId, customKw) {
  const candidates = [];
  const push = (w) => {
    const s = String(w || '').trim();
    if (s.length >= 2 && s.length <= 12 && !candidates.includes(s)) candidates.push(s);
  };

  // 1. 用户显式输入的关键词优先（如果是短词直接保留；若过长也拆出标准短词）
  if (customKw) push(customKw);
  if (primaryKeyword.length <= 6) push(primaryKeyword);

  // 2. 从主/副标题与经历职位中抽取招聘网站高命中标准 2~5 字短词
  const combinedText = [customKw, primaryKeyword, secondaryKeyword, ...(roleParts || [])].join(' ');
  for (const role of KNOWN_SHORT_ROLES) {
    if (combinedText.includes(role)) push(role);
  }
  // 语义组合拆解（长复合职位标题拆出招聘站高命中短词）
  if (/抖音/.test(combinedText)) push('抖音运营');
  if (/直播/.test(combinedText)) push('直播运营');
  if (/电商|店铺|旗舰店/.test(combinedText)) push('电商运营');
  if (/跨境|TikTok|出海|Shopee|Lazada/i.test(combinedText)) push('跨境电商运营');
  if (/AI|大模型|Agent/i.test(combinedText)) push('AI产品经理');

  // 3. 补入最近经历里的短职位名（<= 6 字）
  for (const r of roleParts || []) {
    if (r.length >= 2 && r.length <= 6) push(r);
  }

  // 4. 补入所属行业模板的高命中标准短词
  const tplList = TEMPLATE_SEARCH_QUERIES[templateId] || TEMPLATE_SEARCH_QUERIES.universal_career;
  for (const t of tplList) push(t);

  return candidates;
}

/**
 * 从主简历与用户筛选参数提取搜索与匹配画像（全行业通用）
 */
export function deriveProfileSignals(masterResume, options = {}) {
  const resume = masterResume || {};
  const headline = String(resume.headline || '').trim();
  const basicInfo = String(resume.basicInfo || '').trim();
  const summary = String(resume.summary || '').trim();
  const skills = Array.isArray(resume.skills) ? resume.skills : [];
  const experiences = Array.isArray(resume.experiences) ? resume.experiences : [];

  const fullText = [
    headline,
    basicInfo,
    summary,
    skills.join(' '),
    experiences
      .map((e) => [e.role, e.company, ...(e.highlights || []), ...(e.subProjects || []).map((s) => `${s.name} ${s.role} ${(s.highlights || []).join(' ')}`)].join(' '))
      .join(' '),
  ].join(' ');

  // 1. 提取主关键词
  const customKw = String(options.keyword || '').trim();
  const headlineParts = headline
    .split(/[\/｜|、,，\s]+/)
    .map((x) => x.replace(/^\d+\s*年/, '').trim())
    .filter((x) => x.length >= 2 && x.length <= 20);
  const roleParts = experiences
    .flatMap((e) => [String(e.role || '').trim(), ...(e.subProjects || []).map((sp) => String(sp.role || '').trim())])
    .filter((x) => x.length >= 2 && x.length <= 20);

  const primaryKeyword = customKw || headlineParts[0] || roleParts[0] || '产品经理';
  const secondaryKeyword =
    headlineParts.find((p) => p !== primaryKeyword) ||
    roleParts.find((p) => p !== primaryKeyword) ||
    '';

  const template = detectRoleTemplate(primaryKeyword, fullText);

  // 2. 智能拆解高命中标准检索词（首轮 3 个 + 兜底池）
  const allQueries = buildHighHitQueries(primaryKeyword, secondaryKeyword, roleParts, template.id, customKw);
  const queries = allQueries.slice(0, 3);
  const fallbackQueries = allQueries.slice(3, 6);

  // 3. 城市与期望薪资
  const cfg = loadLocalConfig();
  const city =
    String(options.city || '').trim() ||
    (Array.isArray(cfg.targetPreferences?.targetCities) && cfg.targetPreferences.targetCities[0]) ||
    '上海';

  const targetSalaryK =
    Number(options.targetSalaryK) > 0
      ? Number(options.targetSalaryK)
      : Number(cfg.targetPreferences?.minSalaryK) > 0
        ? Number(cfg.targetPreferences.minSalaryK)
        : 18;

  // 4. 年限与学历识别
  const expMatch = `${basicInfo} ${summary} ${headline}`.match(/(\d+(?:\.\d+)?)\s*年/);
  const yearsExp = expMatch ? Number(expMatch[1]) : Math.max(1, experiences.length * 2);
  let eduLevel = 2; // 1大专 2本科 3硕士 4博士
  if (/博士/.test(basicInfo)) eduLevel = 4;
  else if (/硕士|研究生/.test(basicInfo)) eduLevel = 3;
  else if (/本科/.test(basicInfo)) eduLevel = 2;
  else if (/大专|专科/.test(basicInfo)) eduLevel = 1;

  // 5. 提取核心技能关键词用于匹配打分
  const tokenPool = new Set();
  const extractTokens = (text) => {
    const clean = String(text || '');
    const enWords = clean.match(/[A-Za-z][A-Za-z0-9.+#/-]{1,18}/g) || [];
    for (const w of enWords) {
      if (w.length >= 2) tokenPool.add(w.toLowerCase());
    }
    const cnChunks = clean
      .split(/[：:｜|、,，。；;（()）\s\/\-·•\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 10 && /[\u4e00-\u9fa5]/.test(s));
    for (const c of cnChunks) {
      if (!/^(?:经验|负责|工作|公司|项目|个人|优势|核心|能力|团队|学历|全日制|期望|城市)$/.test(c)) {
        tokenPool.add(c);
      }
    }
  };
  extractTokens(headline);
  skills.forEach(extractTokens);
  extractTokens(summary.slice(0, 300));

  const avoidKeywords = Array.isArray(cfg.targetPreferences?.avoidKeywords)
    ? cfg.targetPreferences.avoidKeywords
    : ['外包', '驻场', '培训贷', '无底薪'];

  return {
    primaryKeyword,
    queries,
    fallbackQueries,
    city,
    targetSalaryK,
    yearsExp,
    eduLevel,
    tokens: [...tokenPool].slice(0, 40),
    templateId: template.id,
    templateName: template.name,
    avoidKeywords,
  };
}

// 15 分钟内存缓存，避免短时间重复点击触发招聘聚合源频控
const JOBUI_CACHE = new Map();
const JOBUI_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * 联网抓取职友集公开聚合职位列表（单次低频 + 本地缓存 + 遇验证码自动停止不绕过）
 */
export async function fetchJobuiJobs({ keyword, city = '', page = 1, timeoutMs = 10000 }) {
  const kwClean = String(keyword || '').trim();
  const cityClean = city && city !== '全国' && city !== '远程' ? String(city).trim() : '';
  const cacheKey = `${kwClean}|${cityClean}|${page}`;
  const cached = JOBUI_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < JOBUI_CACHE_TTL_MS) {
    return cached.data;
  }

  const params = new URLSearchParams();
  params.set('jobKw', kwClean);
  if (cityClean) params.set('cityKw', cityClean);
  if (page > 1) params.set('n', String(page));

  const url = `https://www.jobui.com/jobs?${params.toString()}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    throw new Error(`公开招聘源返回状态码 ${resp.status}`);
  }
  const html = await resp.text();
  if (/验证码验证|安全验证|captcha/i.test(html.slice(0, 2000)) && !html.includes('job-content-box')) {
    throw new Error('公开招聘聚合源当前触发了频控验证（遵守站点规范已自动停止抓取，可稍后重试，或使用下方「模式 B 联网搜岗导入」或配置 Gemini Key）。');
  }
  const blocks = html.split('<div class="job-content-box">').slice(1);
  const results = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.split('<div class="job-addition-box">')[0] || rawBlock.slice(0, 1800);
    const linkMatch = block.match(/<a[^>]*class="job-name"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1].trim();
    const title = decodeHtmlEntities(linkMatch[2]);
    const compMatch = block.match(/<a[^>]*class="job-company-name"[^>]*>([\s\S]*?)<\/a>/i);
    const company = compMatch ? decodeHtmlEntities(compMatch[1]) : '未标注公司';

    const expMatch = block.match(/title="工作经验要求[：:]?([^"]+)"/i);
    const eduMatch = block.match(/title="学历要求[：:]?([^"]+)"/i);
    const payMatch =
      block.match(/class="job-pay-text"[^>]*>([\s\S]*?)<\/span>/i) ||
      block.match(/title="工资[：:]?([^"]+)"/i);

    const experience = expMatch ? decodeHtmlEntities(expMatch[1]) : '经验不限';
    const education = eduMatch ? decodeHtmlEntities(eduMatch[1]) : '学历不限';
    const salary = payMatch ? decodeHtmlEntities(payMatch[1]) : '薪资面议';

    const descSpans = [...block.matchAll(/<span class="job-desc(?:\s+fwb)?">([\s\S]*?)<\/span>/gi)]
      .map((m) => decodeHtmlEntities(m[1]))
      .filter(Boolean);
    const companyMeta = descSpans[0] || '';
    const companyTag = descSpans[1] || '';

    const fullUrl = href.startsWith('http') ? href : `https://www.jobui.com${href}`;
    const jdParts = [
      `【岗位名称】${title}`,
      `【招聘企业】${company}${companyTag ? `（${companyTag}）` : ''}`,
      `【工作城市】${city || '全国'}`,
      `【参考薪资】${salary}`,
      `【经验与学历】${experience} ｜ ${education}`,
      companyMeta ? `【企业规模与行业】${companyMeta}` : '',
      `【岗位来源】全网公开招聘聚合（建议点击原链接查看完整实时 JD 与投递入口）`,
    ].filter(Boolean);

    results.push({
      id: `jobui_${href.replace(/\D+/g, '') || results.length}`,
      platform: '全网公开招聘',
      source: 'jobui',
      company,
      title,
      city: city || '全国',
      salary,
      experience,
      education,
      companyMeta,
      companyTag,
      url: fullUrl,
      jd_text: jdParts.join('\n'),
    });
  }

  if (results.length > 0) {
    JOBUI_CACHE.set(cacheKey, { ts: Date.now(), data: results });
  }
  return results;
}

/**
 * 可选：当用户配置了 Gemini 官方 API Key 时，利用 Gemini 原生 Google Search Grounding 联网补充实时在招岗位
 */
async function fetchGeminiGroundedJobs(signals, config, options = {}) {
  if (config.provider !== 'gemini' || !config.apiKey) return [];
  const count = Math.max(6, Math.min(18, Number(options.count) || 12));
  const excludeCompanies = [
    ...new Set(
      (Array.isArray(options.excludeKeys) ? options.excludeKeys : [])
        .map((k) => String(k || '').split('|')[0].trim())
        .filter(Boolean)
    ),
  ].slice(0, 20);

  const profile = loadPrivateProfile();
  const masterResume = loadMasterResume();
  const sanitized = sanitizeText(
    JSON.stringify({
      headline: masterResume.headline,
      skills: masterResume.skills,
      city: signals.city,
      keyword: signals.primaryKeyword,
      targetSalaryK: signals.targetSalaryK,
    }),
    profile
  );

  addAuditLog({
    jobId: null,
    mode: 'api_web_search',
    provider: `gemini:${config.model || 'gemini-2.5-flash'}:google_search`,
    replacementsCount: sanitized.replacementsCount,
    hitFields: sanitized.hitFields,
    sanitizedPreview: sanitized.sanitizedText,
  });

  const model = config.model || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const excludeHint = excludeCompanies.length
    ? `\n请尽量避开这些已推荐过的公司：${excludeCompanies.join('、')}。`
    : '';
  const prompt = `请使用联网搜索，查找「${signals.city}」地区当前真实在招的「${signals.primaryKeyword}」及相关岗位（目标月薪参考 ${signals.targetSalaryK}K 左右），返回 ${count} 个真实企业的在招职位，均匀覆盖练手训练、主力匹配、进阶挑战三个梯度（每档约 ${Math.max(2, Math.floor(count / 3))} 个）。${excludeHint}
只输出纯 JSON 数组（不要 Markdown 代码块，不要解释），每项结构：
[{"company":"公司名","title":"岗位名","city":"城市","salary":"薪资范围如18-25K","experience":"经验要求","education":"学历要求","platform":"来源平台","url":"岗位链接","jd_text":"岗位核心职责与要求摘要(80-180字)"}]
候选人脱敏画像参考：${sanitized.sanitizedText}`;

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tools: [{ google_search: {} }],
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('\n').trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && x.company && x.title)
      .map((x, idx) => ({
        id: `gemini_${Date.now()}_${idx}`,
        platform: String(x.platform || 'AI联网检索').trim(),
        source: 'gemini_search',
        company: String(x.company).trim(),
        title: String(x.title).trim(),
        city: String(x.city || signals.city).trim(),
        salary: String(x.salary || '薪资面议').trim(),
        experience: String(x.experience || '经验不限').trim(),
        education: String(x.education || '学历不限').trim(),
        companyMeta: '',
        companyTag: '',
        url: String(x.url || '').trim(),
        jd_text: String(x.jd_text || `${x.company} ${x.title}`).trim(),
      }));
  } catch {
    return [];
  }
}

/**
 * 解析公司规模人数上限，用于区分中小热身团队 vs 大平台进阶挑战
 */
function parseCompanyScale(metaText) {
  const s = String(metaText || '');
  if (/10000人|万人|上市|集团|股份/.test(s)) return 4;
  if (/1000-9999|5000|2000/.test(s)) return 3;
  if (/500-999|100-499/.test(s)) return 2;
  return 1;
}

function parseReqEduLevel(eduText) {
  const s = String(eduText || '');
  if (/博士/.test(s)) return 4;
  if (/硕士|研究生/.test(s)) return 3;
  if (/本科/.test(s)) return 2;
  if (/大专|专科/.test(s)) return 1;
  return 0;
}

function parseReqExpYears(expText) {
  const m = String(expText || '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * 对真实抓取到的候选岗位进行匹配打分与三档精准分类（练手训练 / 主力匹配 / 进阶挑战）
 */
export function classifyAndScoreCandidates(rawJobs, signals, opts = {}) {
  const perLimit = Math.max(3, Math.min(15, Number(opts.perTierLimit) || 6));
  const excludeSet = new Set(
    (opts.excludeKeys instanceof Set ? [...opts.excludeKeys] : Array.isArray(opts.excludeKeys) ? opts.excludeKeys : [])
      .map((k) => String(k || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const seen = new Set();
  const deduped = [];
  for (const job of rawJobs || []) {
    const key = `${String(job.company || '').trim().toLowerCase()}|${String(job.title || '').trim().toLowerCase()}`;
    if (!job.title || seen.has(key) || excludeSet.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  const kwLower = signals.primaryKeyword.toLowerCase();
  const kwChars = [...new Set(signals.primaryKeyword.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').split(''))];

  const scored = deduped.map((job) => {
    const hay = `${job.title} ${job.company} ${job.companyTag || ''} ${job.companyMeta || ''} ${job.jd_text || ''}`;
    const hayLower = hay.toLowerCase();
    const titleLower = job.title.toLowerCase();

    // 1. 岗位名称相关性 (0 ~ 40)
    let titleScore = 15;
    if (titleLower.includes(kwLower)) {
      titleScore = 38;
    } else {
      const hitChars = kwChars.filter((ch) => titleLower.includes(ch.toLowerCase())).length;
      titleScore = Math.min(35, Math.round((hitChars / Math.max(1, kwChars.length)) * 34));
    }

    // 2. 技能与行业关键词命中 (0 ~ 25)
    const matchedTokens = signals.tokens.filter((t) => hayLower.includes(t.toLowerCase()));
    const skillScore = Math.min(25, 8 + matchedTokens.length * 4);

    // 3. 薪资匹配度 (0 ~ 20)
    const sal = parseSalaryRangeK(job.salary);
    let salaryScore = 12;
    let salaryRatio = 1.0;
    if (sal && signals.targetSalaryK > 0) {
      salaryRatio = sal.mid / signals.targetSalaryK;
      if (salaryRatio >= 0.88 && salaryRatio <= 1.25) salaryScore = 20;
      else if (salaryRatio >= 0.72 && salaryRatio <= 1.45) salaryScore = 16;
      else if (salaryRatio > 1.45) salaryScore = 14;
      else salaryScore = 10;
    }

    // 4. 门槛与平台规模
    const reqEdu = parseReqEduLevel(job.education);
    const reqExp = parseReqExpYears(job.experience);
    const scale = parseCompanyScale(`${job.company} ${job.companyMeta}`);
    const isLeadTitle = /总监|负责人|经理|主管|架构师|专家|VP|Lead/i.test(job.title);

    let thresholdGap = 0;
    if (reqEdu > signals.eduLevel) thresholdGap += 1;
    if (reqExp > signals.yearsExp + 1) thresholdGap += 1;

    // 风险标记
    const riskFlags = [];
    for (const bad of signals.avoidKeywords || []) {
      if (bad && hay.includes(bad)) riskFlags.push(`包含避坑词「${bad}」`);
    }
    if (reqEdu > signals.eduLevel) riskFlags.push(`学历标称「${job.education}」，需用核心量化成果破格`);
    if (reqExp > signals.yearsExp + 2) riskFlags.push(`年限要求「${job.experience}」，面试需重点突出成熟度`);
    if (sal && sal.max < signals.targetSalaryK * 0.75) riskFlags.push(`标称薪资偏低于目标(${signals.targetSalaryK}K)`);

    const rawScore = Math.max(55, Math.min(97, titleScore + skillScore + salaryScore - (riskFlags.length > 1 ? 5 : 0)));

    // 计算「挑战指数」：正值偏进阶挑战，负值偏练手热身，中间偏主力匹配
    let challengeIndex = 0;
    if (sal) {
      if (salaryRatio >= 1.18) challengeIndex += 2.2;
      else if (salaryRatio <= 0.86) challengeIndex -= 2.0;
    }
    if (scale >= 3) challengeIndex += 1.4;
    else if (scale <= 1) challengeIndex -= 1.0;
    if (thresholdGap >= 1) challengeIndex += 1.6;
    if (isLeadTitle && !/总监|负责人|架构师/.test(signals.primaryKeyword)) challengeIndex += 1.2;

    return {
      ...job,
      match_score: rawScore,
      matched_keywords: matchedTokens.slice(0, 6),
      risk_flags: riskFlags,
      salary_parsed: sal,
      scale,
      thresholdGap,
      challengeIndex,
    };
  });

  // 按匹配分先筛优，放宽候选池上限以支持动态多条推荐与追加
  scored.sort((a, b) => b.match_score - a.match_score);
  const topPool = scored.slice(0, perLimit * 3 + 9);

  const buckets = { practice: [], core: [], stretch: [] };
  const unassigned = [];

  for (const item of topPool) {
    if (item.challengeIndex >= 1.5 && buckets.stretch.length < perLimit) {
      buckets.stretch.push(item);
    } else if (item.challengeIndex <= -0.8 && buckets.practice.length < perLimit) {
      buckets.practice.push(item);
    } else {
      unassigned.push(item);
    }
  }

  // 均衡补齐三个档次，动态适配 perLimit 容量
  for (const item of unassigned) {
    if (buckets.core.length < perLimit) {
      buckets.core.push(item);
    } else if (buckets.practice.length < perLimit && item.challengeIndex <= 0.5) {
      buckets.practice.push(item);
    } else if (buckets.stretch.length < perLimit) {
      buckets.stretch.push(item);
    } else if (buckets.practice.length < perLimit) {
      buckets.practice.push(item);
    }
  }

  // 均衡调剂：总数 >= 6 时尽量保障每档至少 2 个；总数 >= 3 时保底每档至少 1 个
  const minTarget = topPool.length >= 6 ? 2 : topPool.length >= 3 ? 1 : 0;
  while (buckets.practice.length < minTarget && buckets.core.length > minTarget) {
    buckets.core.sort((a, b) => a.challengeIndex - b.challengeIndex);
    buckets.practice.push(buckets.core.shift());
  }
  while (buckets.stretch.length < minTarget && buckets.core.length > minTarget) {
    buckets.core.sort((a, b) => b.challengeIndex - a.challengeIndex);
    buckets.stretch.push(buckets.core.shift());
  }
  while (buckets.practice.length < minTarget && buckets.stretch.length > minTarget) {
    buckets.stretch.sort((a, b) => a.challengeIndex - b.challengeIndex);
    buckets.practice.push(buckets.stretch.shift());
  }
  while (buckets.stretch.length < minTarget && buckets.practice.length > minTarget) {
    buckets.practice.sort((a, b) => b.challengeIndex - a.challengeIndex);
    buckets.stretch.push(buckets.practice.shift());
  }

  const enrich = (item, tier) => {
    const meta = TIER_META[tier];
    const kwNote = item.matched_keywords.length
      ? `命中简历关键词：${item.matched_keywords.slice(0, 4).join('、')}`
      : `与目标方向「${signals.primaryKeyword}」高度相关`;

    let tierReason = '';
    let breakthroughTip = '';
    if (tier === 'practice') {
      tierReason = `门槛友好（${item.experience} / ${item.education}），${kwNote}，非常适合先约面刷面试手感、测试自我介绍与薪资报价反应。`;
      breakthroughTip = '面试目标：把你最拿手的 1~2 个量化项目讲顺，并借机收集真实面试官的高频追问。';
    } else if (tier === 'core') {
      tierReason = `薪资与职级最贴合你的主力预期（${item.salary}），${kwNote}，建议重点投入精力拿 Offer。`;
      breakthroughTip = '面试目标：简历上半屏直接对齐核心业绩指标，打招呼第一句就亮出年限与最强结果数据。';
    } else {
      tierReason = `具备更高薪资空间或更大平台背书（${item.salary}${item.scale >= 3 ? ' · 中大型/头部企业' : ''}），${kwNote}，值得冲刺跃迁。`;
      breakthroughTip =
        item.thresholdGap > 0
          ? '破格切入点：绕开硬性门槛焦虑，打招呼与简历首屏直接用「可复用的方法论 + 真实增量数据」证明即战力。'
          : '跃迁切入点：强调跨团队推进、方法论沉淀与业务降本增效能力，展现高一档职级视野。';
    }

    return {
      id: item.id,
      tier,
      tier_label: meta.label,
      platform: item.platform,
      source: item.source,
      company: item.company,
      title: item.title,
      city: item.city,
      salary: item.salary,
      experience: item.experience,
      education: item.education,
      companyMeta: item.companyMeta,
      companyTag: item.companyTag,
      url: item.url,
      jd_text: item.jd_text,
      match_score: item.match_score,
      matched_keywords: item.matched_keywords,
      risk_flags: item.risk_flags,
      tier_reason: tierReason,
      breakthrough_tip: breakthroughTip,
    };
  };

  return {
    practice: buckets.practice.sort((a, b) => b.match_score - a.match_score).slice(0, perLimit).map((x) => enrich(x, 'practice')),
    core: buckets.core.sort((a, b) => b.match_score - a.match_score).slice(0, perLimit).map((x) => enrich(x, 'core')),
    stretch: buckets.stretch.sort((a, b) => b.match_score - a.match_score).slice(0, perLimit).map((x) => enrich(x, 'stretch')),
  };
}

/**
 * 生成脱敏联网搜岗协作提示词（模式 B：零 API Key 且遇频控时，交给任意带联网能力的 AI 助手搜回真实岗位 JSON）
 */
export function buildDiscoverCollabPrompt(signals) {
  return `请使用联网搜索，帮我查找「${signals.city}」地区当前真实在招的「${signals.primaryKeyword}」（相关词：${(signals.queries || []).join(' / ')}）岗位，目标月薪基准 ${signals.targetSalaryK}K 左右。
请精选 12 个真实在招企业岗位（练手训练、主力匹配、进阶挑战每档约 4 个），覆盖：
- 练手训练档（门槛友好、适合热身练面试）
- 主力匹配档（经历与薪资最契合）
- 进阶挑战档（大平台或高一档薪资/职级）
只输出合法的纯 JSON 数组（不要多余解释），字段格式如下：
[
  {
    "company": "真实公司名称",
    "title": "岗位名称",
    "city": "${signals.city}",
    "salary": "如 18-25K",
    "experience": "如 3-5年",
    "education": "如 本科及以上",
    "platform": "Boss直聘/猎聘/企业官网",
    "url": "岗位直达链接",
    "jd_text": "岗位职责与核心任职要求摘要(80~180字)"
  }
]`;
}

/**
 * 模式 B 导入外部 AI 联网搜回的岗位 JSON 并自动执行三档分类打分
 */
export function importDiscoveredJobsJson(rawText, options = {}) {
  const masterResume = loadMasterResume();
  const signals = deriveProfileSignals(masterResume, options);
  const queryPool = [...new Set([...(signals.queries || []), ...(signals.fallbackQueries || []), signals.primaryKeyword].filter(Boolean))];
  const text = String(rawText || '').trim();
  if (!text) throw new Error('请先粘贴联网搜岗返回的 JSON 数组。');

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      parsed = JSON.parse(fenced[1].trim());
    } else {
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) throw new Error('未能从输入中解析出合法的 JSON 数组，请检查格式。');
      parsed = JSON.parse(m[0]);
    }
  }

  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  if (!list.length) throw new Error('JSON 中未包含任何有效岗位记录。');

  const normalized = list
    .filter((x) => x && (x.company || x.title))
    .map((x, idx) => ({
      id: `collab_${Date.now()}_${idx}`,
      platform: String(x.platform || 'AI联网协作检索').trim(),
      source: 'collab_import',
      company: String(x.company || '未命名公司').trim(),
      title: String(x.title || signals.primaryKeyword).trim(),
      city: String(x.city || signals.city).trim(),
      salary: String(x.salary || '薪资面议').trim(),
      experience: String(x.experience || '经验不限').trim(),
      education: String(x.education || '学历不限').trim(),
      companyMeta: String(x.companyMeta || '').trim(),
      companyTag: String(x.companyTag || '').trim(),
      url: String(x.url || '').trim(),
      jd_text: String(x.jd_text || `${x.company || ''} ${x.title || ''}`).trim(),
    }));

  const tiers = classifyAndScoreCandidates(normalized, signals, {
    perTierLimit: Number(options.perTierLimit) || 12,
    excludeKeys: options.excludeKeys || [],
  });
  const totalRecommended = tiers.practice.length + tiers.core.length + tiers.stretch.length;

  return {
    searchedAt: new Date().toISOString(),
    signals: {
      primaryKeyword: signals.primaryKeyword,
      queries: signals.queries,
      queryPool,
      city: signals.city,
      targetSalaryK: signals.targetSalaryK,
      templateId: signals.templateId,
      templateName: signals.templateName,
    },
    sourcesUsed: [`模式B联网协作导入(${normalized.length}条)`],
    warnings: [],
    collabPrompt: buildDiscoverCollabPrompt(signals),
    totalFound: normalized.length,
    totalRecommended,
    tierMeta: TIER_META,
    tiers,
  };
}

/**
 * 电脑端主入口：根据主简历 + 筛选条件，单次低频联网搜索（支持翻页与切词追加）并输出三档精准推荐
 */
export async function searchAndRecommendJobs(options = {}) {
  const masterResume = loadMasterResume();
  const config = loadLocalConfig();
  const signals = deriveProfileSignals(masterResume, options);

  const queryPool = [...new Set([...(signals.queries || []), ...(signals.fallbackQueries || []), signals.primaryKeyword].filter(Boolean))];
  const safeQueryIndex = queryPool.length ? Math.abs(Number(options.queryIndex) || 0) % queryPool.length : 0;
  const activeQuery = queryPool[safeQueryIndex] || signals.primaryKeyword;
  const safePage = Math.max(1, Math.min(5, Number(options.page) || 1));
  const perTierLimit = Math.max(3, Math.min(15, Number(options.perTierLimit) || 6));
  const excludeKeys = Array.isArray(options.excludeKeys) ? options.excludeKeys : [];

  const sourcesUsed = [];
  const warnings = [];
  const collected = [];

  // 1. 优先：如配置了 Gemini 官方 API Key，使用官方 Google Search Grounding 联网抓取（永不触发验证码）
  if (options.useGeminiSearch !== false && config.provider === 'gemini' && config.apiKey) {
    try {
      const gList = await fetchGeminiGroundedJobs(signals, config, {
        count: perTierLimit * 2,
        excludeKeys,
      });
      if (gList.length) sourcesUsed.push(`Gemini联网搜索(${gList.length}条)`);
      collected.push(...gList);
    } catch (err) {
      warnings.push(`Gemini 联网检索未命中：${err.message}`);
    }
  }

  // 2. 公开招聘源：严格单次低频请求（支持翻页或切换相关短词追加，遇到验证码立即停止不绕过）
  let jobuiFetchedCount = 0;
  if (collected.length < 8) {
    try {
      const list = await fetchJobuiJobs({ keyword: activeQuery, city: signals.city, page: safePage });
      jobuiFetchedCount = list.length;
      if (list.length) sourcesUsed.push(`公开招聘检索(${activeQuery}·第${safePage}页: ${list.length}条)`);
      collected.push(...list);
    } catch (err) {
      warnings.push(err.message);
    }
  }

  const tiers = classifyAndScoreCandidates(collected, signals, { perTierLimit, excludeKeys });
  const totalCount = tiers.practice.length + tiers.core.length + tiers.stretch.length;
  const nextPage = jobuiFetchedCount >= 10 && safePage < 5 ? safePage + 1 : 1;
  const nextQueryIndex = nextPage === 1 ? (safeQueryIndex + 1) % Math.max(1, queryPool.length) : safeQueryIndex;

  return {
    searchedAt: new Date().toISOString(),
    page: safePage,
    queryIndex: safeQueryIndex,
    activeQuery,
    queryPool,
    nextPage,
    nextQueryIndex,
    signals: {
      primaryKeyword: signals.primaryKeyword,
      queries: signals.queries,
      queryPool,
      city: signals.city,
      targetSalaryK: signals.targetSalaryK,
      templateId: signals.templateId,
      templateName: signals.templateName,
    },
    sourcesUsed,
    warnings,
    collabPrompt: buildDiscoverCollabPrompt(signals),
    totalFound: collected.length,
    totalRecommended: totalCount,
    tierMeta: TIER_META,
    tiers,
  };
}

/**
 * 零 API Key 本地智能定制简历与 3 套打招呼话术（100% 忠实于主简历事实，绝不虚构）
 */
export function buildLocalTailoredBundle(job, masterResume, tier = '') {
  const resume = masterResume || loadMasterResume();
  const jdText = `${job.title || ''} ${job.company || ''} ${job.jd_text || ''}`;
  const jdLower = jdText.toLowerCase();

  // 提取 JD 关键词用于相关性重排
  const jdTokens = [
    ...new Set(
      (jdText.match(/[A-Za-z][A-Za-z0-9.+#/-]{1,18}/g) || [])
        .map((w) => w.toLowerCase())
        .concat(
          jdText
            .split(/[：:｜|、,，。；;（()）\s\/\-·•\n【】]+/)
            .map((s) => s.trim())
            .filter((s) => s.length >= 2 && s.length <= 8 && /[\u4e00-\u9fa5]/.test(s))
        )
    ),
  ];

  const relevance = (text) => {
    const low = String(text || '').toLowerCase();
    let score = 0;
    for (const tk of jdTokens) {
      if (low.includes(tk)) score += 1;
    }
    return score;
  };

  // 按与本岗位的相关性重排技能分组（绝不新增未拥有的技能）
  const sortedSkills = [...(resume.skills || [])].sort((a, b) => relevance(b) - relevance(a));

  // 按与本岗位的相关性微调总结要点顺序
  const summaryLines = String(resume.summary || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const sortedSummary = [...summaryLines].sort((a, b) => relevance(b) - relevance(a));

  // 保留全部真实工作经历与嵌套子项目，只对单段经历内部的亮点要点按相关性重排
  const tailoredExperiences = (resume.experiences || []).map((exp) => ({
    company: exp.company || '',
    role: exp.role || '',
    period: exp.period || '',
    highlights: [...(exp.highlights || [])].sort((a, b) => relevance(b) - relevance(a)),
    subProjects: (exp.subProjects || []).map((sp) => ({
      name: sp.name || '',
      role: sp.role || '',
      period: sp.period || '',
      highlights: [...(sp.highlights || [])].sort((a, b) => relevance(b) - relevance(a)),
    })),
  }));

  const tailoredProjects = (resume.projects || []).map((p) => ({
    name: p.name || '',
    role: p.role || '',
    period: p.period || '',
    highlights: [...(p.highlights || [])].sort((a, b) => relevance(b) - relevance(a)),
  }));

  // 提炼候选人第一条核心成果（严格来自主简历原文）用于打招呼话术
  const firstHighlight =
    sortedSummary[0] ||
    tailoredExperiences[0]?.highlights?.[0] ||
    tailoredExperiences[0]?.subProjects?.[0]?.highlights?.[0] ||
    '具备完整的一线实战与独立拿结果经验';
  const cleanHighlight = firstHighlight.replace(/^[•·\-*\d.、\s]+/, '').slice(0, 68);
  const expBrief = String(resume.basicInfo || '').trim();
  const topSkill = (sortedSkills[0] || '').replace(/[：:].*$/, '').trim() || (job.title || '核心业务');
  const tierTag = TIER_META[tier]?.label || '';

  const greetings = [
    {
      style: '直给成果型（推荐）',
      text: `您好！看到贵司（${job.company}）在招「${job.title}」，我的背景与岗位高度契合${expBrief ? `（${expBrief}）` : ''}。过往实战中，${cleanHighlight}。非常认可贵司的业务方向，已针对该岗位整理好适配简历，方便发您进一步评估并约时间沟通吗？`,
    },
    {
      style: '业务切入型',
      text: `您好！关注到贵司正在招聘「${job.title}」，我在${topSkill}方面有扎实的落地沉淀，擅长把业务目标拆解为可执行的指标并拿到确定性结果（例如：${cleanHighlight}）。想进一步了解咱们团队目前的核心发力点，方便把简历发您看看吗？`,
    },
    {
      style: tier === 'stretch' ? '破格冲刺亮数据型' : '高效约面沟通型',
      text:
        tier === 'stretch'
          ? `您好！非常看重贵司「${job.title}」的平台空间。我属于能直接上手扛指标的实战型人选，过往曾做到：${cleanHighlight}。希望能有机会用具体项目复盘和打法展示自身即战力，方便发一份定制简历给您参考吗？`
          : `您好！看到贵司「${job.title}」的岗位需求后觉得非常同频，${cleanHighlight}。如果咱们岗位目前还在推进面试，我随时方便发简历并配合线上或线下交流，期待您的回复！`,
    },
  ];

  // 找出简历与 JD 之间的缺失高频词
  const resumeTextLower = JSON.stringify(resume).toLowerCase();
  const missingSkills = jdTokens
    .filter((tk) => tk.length >= 2 && tk.length <= 10 && !resumeTextLower.includes(tk))
    .filter((tk) => !/^(?:岗位名称|招聘企业|工作城市|参考薪资|经验与学历|企业规模|岗位来源|有限公司|股份|科技|点击|查看|完整|实时|投递|入口|以上|不限|经验|学历|薪资|面议|全国)$/.test(tk))
    .slice(0, 5);

  const matchedCount = jdTokens.filter((tk) => resumeTextLower.includes(tk)).length;
  const computedScore =
    Number.isFinite(Number(job.match_score)) && Number(job.match_score) > 0
      ? Number(job.match_score)
      : Math.max(68, Math.min(94, 72 + matchedCount * 3));

  const tailoredResume = {
    headline: job.title ? `${job.title}${resume.headline && !resume.headline.includes(job.title) ? ` / ${resume.headline.split(/[\/｜|]/)[0].trim()}` : ''}` : resume.headline || '',
    basicInfo: resume.basicInfo || '',
    summary: sortedSummary.join('\n') || resume.summary || '',
    skills: sortedSkills,
    experiences: tailoredExperiences,
    projects: tailoredProjects,
    education: resume.education || [],
  };

  return {
    match_score: computedScore,
    match_summary:
      job.tier_reason ||
      `${tierTag ? `【${tierTag}】` : ''}已基于主简历事实自动重排与「${job.title}」最相关的优势与技能，并生成 3 套专属打招呼话术。`,
    risk_flags: Array.isArray(job.risk_flags) ? job.risk_flags : [],
    missing_skills: missingSkills,
    tailored_resume: tailoredResume,
    greetings,
  };
}

/**
 * 一键采纳用户勾选的推荐岗位：入库 + 标记三档 + 自动生成专属定制简历 + 3 套打招呼话术 + 挂载15+面试题库
 */
export async function adoptRecommendedJobs(candidates = [], options = {}) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  if (!list.length) throw new Error('请至少选择一个推荐岗位。');

  const cfg = loadLocalConfig();
  const masterResume = loadMasterResume();
  const existingJobs = listJobs();
  const existingMap = new Map(
    existingJobs.map((j) => [`${j.company.trim().toLowerCase()}|${j.title.trim().toLowerCase()}`, j])
  );

  const adopted = [];

  for (const cand of list) {
    const company = String(cand.company || '').trim() || '未命名公司';
    const title = String(cand.title || '').trim() || '未命名岗位';
    const tier = ['practice', 'core', 'stretch'].includes(cand.tier) ? cand.tier : '';
    const dedupKey = `${company.toLowerCase()}|${title.toLowerCase()}`;

    let job = existingMap.get(dedupKey);
    let alreadyExisted = false;

    if (!job) {
      job = createJob({
        platform: cand.platform || '全网公开招聘',
        company,
        title,
        city: cand.city || '',
        salary: cand.salary || '',
        url: cand.url || '',
        jd_text: cand.jd_text || `${company} - ${title}（${cand.salary || '薪资面议'}）`,
        tier,
        notes: [cand.tier_reason, cand.breakthrough_tip].filter(Boolean).join('\n'),
      });
      existingMap.set(dedupKey, job);
    } else {
      alreadyExisted = true;
      if (tier && !job.tier) {
        job = updateJob(job.id, { tier });
      }
    }

    // 1. 先自动挂载对应行业 15+ 题库
    try {
      applyRoleTemplateToJob(job.id, '');
    } catch {
      // 忽略非关键异常
    }

    // 2. 生成专属定制简历与打招呼话术（若用户明确开启 API 深度生成且有 Key，则调用官方脱敏 API；否则秒级本地生成）
    let generationMode = 'local_smart';
    if (options.useApi && cfg.apiKey) {
      try {
        await runApiAnalysis(job.id);
        job = getJobById(job.id);
        generationMode = 'api';
      } catch {
        // API 异常时自动降级本地智能生成，保证闭环不断裂
      }
    }

    if (generationMode !== 'api' || !job.tailored_resume) {
      const localBundle = buildLocalTailoredBundle(
        { ...job, match_score: cand.match_score, risk_flags: cand.risk_flags, tier_reason: cand.tier_reason },
        masterResume,
        tier
      );
      job = updateJob(job.id, {
        tier: tier || job.tier,
        match_score: localBundle.match_score,
        match_summary: localBundle.match_summary,
        risk_flags: localBundle.risk_flags,
        missing_skills: localBundle.missing_skills,
        tailored_resume: localBundle.tailored_resume,
        greetings: localBundle.greetings,
        selected_greeting: localBundle.greetings[0]?.text || '',
        greeting_style: localBundle.greetings[0]?.style || '',
        status: job.status === 'new' ? 'ready' : job.status,
      });
    }

    // 3. 可选自动渲染一页版 PDF 简历
    let pdfInfo = null;
    if (options.generatePdf !== false) {
      try {
        pdfInfo = generateJobResumePdf(job.id);
        job = getJobById(job.id);
      } catch (err) {
        pdfInfo = { error: err.message };
      }
    }

    adopted.push({
      job,
      alreadyExisted,
      generationMode,
      pdf: pdfInfo,
    });
  }

  return {
    count: adopted.length,
    adopted,
  };
}
