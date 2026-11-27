import fs from 'node:fs';
import { PATHS, ensureDataDirs } from './paths.mjs';

// 最高隐私档案模板（永不外发）
const DEFAULT_PRIVATE_PROFILE = {
  name: '请填写你的真实姓名',
  phone: '13800000000',
  email: 'yourname@example.com',
  wechat: 'your_wechat_id',
  location: '上海',
  extraSensitiveWords: [
    // 可填你当前就职公司的敏感全称、内部项目代号等，发送给 AI 前会自动打码
  ],
};

// 本地运行配置（含双模式切换、官方直连 API 与手机局域网安全访问开关）
const DEFAULT_LOCAL_CONFIG = {
  // 默认支持双模式切换：'collab'（零 API Key 协作模式）或 'api'（脱敏后直连官方 API）
  aiMode: 'collab',
  provider: 'gemini', // 'gemini' | 'deepseek' | 'openai_compatible'
  apiKey: '',
  model: 'gemini-2.5-flash',
  baseUrl: '',
  // 手机同 Wi-Fi 访问控制：默认关闭，仅 127.0.0.1 本机访问；开启后强制校验 6 位访问口令
  allowLanAccess: false,
  accessPin: '',
  targetPreferences: {
    targetTitles: ['高级前端工程师', '全栈开发工程师'],
    targetCities: ['上海', '北京', '远程'],
    minSalaryK: 20,
    avoidKeywords: ['外包', '驻场', '大小周', '培训贷', '无底薪'],
  },
};

// 全量主简历模板（放在 data/resumes/master_resume.json，不含真实隐私联系方式）
const DEFAULT_MASTER_RESUME = {
  headline: '5年全栈 / 前端开发工程师',
  basicInfo: '5年工作经验',
  summary:
    '具备中大型 Web 应用架构与性能优化经验，擅长从 0 到 1 推进核心业务落地，注重代码质量与业务转化结果。',
  education: [
    {
      school: '某某大学',
      degree: '本科 · 计算机科学与技术',
      period: '2016.09 - 2020.06',
    },
  ],
  skills: [
    'JavaScript / TypeScript / Node.js',
    'Vue 3 / React / Vite',
    'MySQL / SQLite / Redis',
    '性能优化 / 工程化 / CI/CD',
  ],
  experiences: [
    {
      company: '示例科技公司（可在隐私设置中配置脱敏词）',
      role: '高级开发工程师',
      period: '2022.04 - 至今',
      highlights: [
        '主导核心 SaaS 平台重构，首屏加载时间由 3.2s 降至 0.9s，客户续费率提升 12%。',
        '设计通用表单与工作流引擎，将新业务页面交付周期缩短 40%。',
      ],
      subProjects: [],
    },
    {
      company: '示例互联网公司',
      role: '开发工程师',
      period: '2020.07 - 2022.03',
      highlights: [
        '负责 B 端运营后台与数据看板开发，支撑日均 50 万次内部查询。',
        '推进前端错误监控与自动化测试体系落地，线上 P1 故障同比下降 60%。',
      ],
      subProjects: [],
    },
  ],
  projects: [
    {
      name: '智能业务分析平台',
      role: '核心负责人',
      period: '2023.06 - 2024.08',
      highlights: [
        '搭建可配置图表与异步导出系统，解决十万级数据渲染卡顿问题。',
        '打通权限与审计日志模块，满足企业客户私有化部署安全要求。',
      ],
    },
  ],
};

function readOrInitJson(filePath, defaultObj) {
  ensureDataDirs();
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultObj, null, 2), 'utf8');
    return structuredClone(defaultObj);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

export function loadPrivateProfile() {
  return readOrInitJson(PATHS.privateProfilePath, DEFAULT_PRIVATE_PROFILE);
}

export function savePrivateProfile(profile) {
  ensureDataDirs();
  const merged = {
    ...DEFAULT_PRIVATE_PROFILE,
    ...profile,
    extraSensitiveWords: Array.isArray(profile?.extraSensitiveWords)
      ? profile.extraSensitiveWords.map((s) => String(s).trim()).filter(Boolean)
      : [],
  };
  fs.writeFileSync(PATHS.privateProfilePath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function loadLocalConfig() {
  const cfg = readOrInitJson(PATHS.localConfigPath, DEFAULT_LOCAL_CONFIG);
  return {
    ...DEFAULT_LOCAL_CONFIG,
    ...cfg,
    targetPreferences: {
      ...DEFAULT_LOCAL_CONFIG.targetPreferences,
      ...(cfg.targetPreferences || {}),
    },
  };
}

export function saveLocalConfig(config) {
  ensureDataDirs();
  const prev = loadLocalConfig();
  const merged = {
    ...prev,
    ...config,
    // 如果前端回传掩码后的 key（如 "****1234"），保留原真实 key
    apiKey:
      typeof config?.apiKey === 'string' && config.apiKey.startsWith('****')
        ? prev.apiKey
        : config?.apiKey ?? prev.apiKey,
    targetPreferences: {
      ...prev.targetPreferences,
      ...(config?.targetPreferences || {}),
    },
  };
  fs.writeFileSync(PATHS.localConfigPath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 6) return '****';
  return `****${key.slice(-4)}`;
}

export function loadMasterResume() {
  return readOrInitJson(PATHS.masterResumePath, DEFAULT_MASTER_RESUME);
}

export function saveMasterResume(resume) {
  ensureDataDirs();
  fs.writeFileSync(PATHS.masterResumePath, JSON.stringify(resume, null, 2), 'utf8');
  return resume;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 强隐私脱敏：将真实姓名、手机号、邮箱、微信、敏感词及正则兜底模式全部替换为占位符
 */
export function sanitizeText(inputText, profile = loadPrivateProfile()) {
  let text = String(inputText ?? '');
  let replacementsCount = 0;
  const hitFields = new Set();

  const replaceLiteral = (value, token, fieldLabel) => {
    const clean = String(value || '').trim();
    if (!clean || clean.length < 2) return;
    // 忽略尚未修改的示例占位文案
    if (clean.includes('请填写') || clean === '13800000000' || clean === 'yourname@example.com') return;
    const regex = new RegExp(escapeRegExp(clean), 'g');
    const matches = text.match(regex);
    if (matches && matches.length > 0) {
      text = text.replace(regex, token);
      replacementsCount += matches.length;
      hitFields.add(fieldLabel);
    }
  };

  replaceLiteral(profile.name, '{{NAME}}', '姓名');
  replaceLiteral(profile.phone, '{{PHONE}}', '手机号');
  replaceLiteral(profile.email, '{{EMAIL}}', '邮箱');
  replaceLiteral(profile.wechat, '{{WECHAT}}', '微信号');

  (profile.extraSensitiveWords || []).forEach((word, idx) => {
    replaceLiteral(word, `{{SENSITIVE_${idx + 1}}}`, `敏感词#${idx + 1}`);
  });

  // 正则兜底：防止经历文本里不小心手写了手机号、邮箱或身份证号
  const regexRules = [
    { label: '正则手机号', regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g, token: '{{PHONE_MASKED}}' },
    { label: '正则邮箱', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, token: '{{EMAIL_MASKED}}' },
    { label: '正则身份证号', regex: /(?<!\d)\d{17}[\dXx](?!\d)/g, token: '{{ID_MASKED}}' },
  ];

  for (const rule of regexRules) {
    const matches = text.match(rule.regex);
    if (matches && matches.length > 0) {
      text = text.replace(rule.regex, rule.token);
      replacementsCount += matches.length;
      hitFields.add(rule.label);
    }
  }

  return {
    sanitizedText: text,
    replacementsCount,
    hitFields: [...hitFields],
  };
}

/**
 * 本地还原：仅在生成本机 PDF 简历或最终发给 HR 的话术时调用，绝不外发
 */
export function restoreText(inputText, profile = loadPrivateProfile()) {
  let text = String(inputText ?? '');
  const map = [
    ['{{NAME}}', profile.name || ''],
    ['{{PHONE}}', profile.phone || ''],
    ['{{EMAIL}}', profile.email || ''],
    ['{{WECHAT}}', profile.wechat || ''],
  ];
  (profile.extraSensitiveWords || []).forEach((word, idx) => {
    map.push([`{{SENSITIVE_${idx + 1}}}`, word]);
  });

  for (const [token, val] of map) {
    if (val) {
      text = text.split(token).join(val);
    }
  }
  return text;
}

export function restoreObjectDeep(obj, profile = loadPrivateProfile()) {
  if (typeof obj === 'string') return restoreText(obj, profile);
  if (Array.isArray(obj)) return obj.map((item) => restoreObjectDeep(item, profile));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = restoreObjectDeep(v, profile);
    }
    return out;
  }
  return obj;
}
