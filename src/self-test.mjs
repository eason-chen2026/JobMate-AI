import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// 构造最小合法 .docx (ZIP) 用于离线解析测试
function buildMinimalDocxBuffer(xmlContent) {
  const nameBuf = Buffer.from('word/document.xml', 'utf8');
  const rawBuf = Buffer.from(xmlContent, 'utf8');
  const compBuf = zlib.deflateRawSync(rawBuf);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(compBuf.length, 18);
  localHeader.writeUInt32LE(rawBuf.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const localRecord = Buffer.concat([localHeader, nameBuf, compBuf]);

  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(20, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(0, 8);
  cdHeader.writeUInt16LE(8, 10);
  cdHeader.writeUInt32LE(0, 16);
  cdHeader.writeUInt32LE(compBuf.length, 20);
  cdHeader.writeUInt32LE(rawBuf.length, 24);
  cdHeader.writeUInt16LE(nameBuf.length, 28);
  cdHeader.writeUInt16LE(0, 30);
  cdHeader.writeUInt16LE(0, 32);
  cdHeader.writeUInt32LE(0, 42);

  const cdRecord = Buffer.concat([cdHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localRecord, cdRecord, eocd]);
}

// 使用独立临时目录执行测试，不污染正式本地数据目录
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-copilot-test-'));
process.env.JOB_COPILOT_DATA_DIR = testDataDir;

const { closeDb } = await import('./db.mjs');
const { sanitizeText, restoreText, savePrivateProfile } = await import('./privacy.mjs');
const { exportCollabTask, importCollabTaskResult } = await import('./ai.mjs');
const { generateJobResumePdf } = await import('./pdf.mjs');
const { createAppServer } = await import('./server.mjs');

let server = null;
try {
  // 1. 测试隐私脱敏与本地还原
  const profile = savePrivateProfile({
    name: '林示例',
    phone: '13800138001',
    email: 'demo@example.com',
    wechat: 'demo_wechat_01',
    location: '上海',
    extraSensitiveWords: ['示例科技公司A'],
  });

  const dirty = '我是林示例，在示例科技公司A工作，电话13800138001，备用13800138002，邮箱demo@example.com，微信demo_wechat_01。';
  const sanitized = sanitizeText(dirty, profile);
  assert.ok(!sanitized.sanitizedText.includes('林示例'), '真实姓名未脱敏');
  assert.ok(!sanitized.sanitizedText.includes('13800138001'), '手机号未脱敏');
  assert.ok(!sanitized.sanitizedText.includes('13800138002'), '正则兜底手机号未脱敏');
  assert.ok(!sanitized.sanitizedText.includes('demo@example.com'), '邮箱未脱敏');
  assert.ok(!sanitized.sanitizedText.includes('demo_wechat_01'), '微信号未脱敏');
  assert.ok(!sanitized.sanitizedText.includes('示例科技公司A'), '自定义敏感词未脱敏');
  assert.ok(sanitized.replacementsCount >= 6, '脱敏计数异常');

  const restored = restoreText('你好，我是{{NAME}}，曾在{{SENSITIVE_1}}任职。', profile);
  assert.equal(restored, '你好，我是林示例，曾在示例科技公司A任职。');
  console.log('[PASS] 1. 隐私脱敏与本地还原验证通过');

  // 2. 启动 HTTP 服务测试完整 API 闭环
  server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 2.1 新增岗位
  const createResp = await fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: 'Boss直聘',
      company: '示例互娱',
      title: '高级前端开发工程师',
      city: '上海',
      salary: '28-38K',
      jd_text: '负责前端架构优化、TypeScript/Vue3 开发、性能调优与工程化建设。',
    }),
  });
  assert.equal(createResp.status, 201);
  const { job } = await createResp.json();
  assert.equal(job.company, '示例互娱');
  console.log('[PASS] 2. HTTP 新增岗位与 SQLite 落库验证通过');

  // 3. 测试模式 B 脱敏协作包导出与结果导入
  const collab = exportCollabTask(job.id);
  assert.ok(fs.existsSync(collab.taskPath), '脱敏任务文件未生成');
  const taskContent = fs.readFileSync(collab.taskPath, 'utf8');
  assert.ok(!taskContent.includes('13800138001'), '导出任务文件包含隐私信息');

  const mockResult = {
    match_score: 88,
    match_summary: '核心技术栈与性能优化经验高度契合。',
    risk_flags: [],
    missing_skills: ['WebGL'],
    tailored_resume: {
      headline: '高级前端开发工程师',
      summary: '5年前端架构与性能优化实战经验，主导大型平台首屏优化至 0.9s。',
      skills: ['TypeScript / Vue 3 / Vite', '前端性能优化 / 工程化'],
      experiences: [
        {
          company: '{{SENSITIVE_1}}',
          role: '高级前端开发工程师',
          period: '2022.04 - 至今',
          highlights: ['主导核心平台重构，首屏加载时间降至 0.9s。'],
        },
      ],
      projects: [],
      education: [{ school: '某某大学', degree: '本科 · 计算机', period: '2016 - 2020' }],
    },
    greetings: [
      { style: '直给成果型', text: '您好，看到贵司在招高级前端，我有5年Vue3/TS架构经验，曾把核心平台首屏从3.2s优化到0.9s，方便发份简历进一步沟通吗？' },
    ],
  };

  const imported = importCollabTaskResult(job.id, mockResult);
  assert.equal(imported.match_score, 88);
  assert.equal(imported.tailored_resume.experiences[0].company, '示例科技公司A', '本地还原失败');
  console.log('[PASS] 3. 模式 B 脱敏任务导出、结果导入与本地还原验证通过');

  // 4. 测试离线 PDF 渲染
  const pdfResult = generateJobResumePdf(job.id);
  assert.ok(fs.existsSync(pdfResult.pdfPath), 'PDF 文件未生成');
  const header = fs.readFileSync(pdfResult.pdfPath).subarray(0, 5).toString('utf8');
  assert.equal(header, '%PDF-', '生成的不是合法 PDF 文件');
  console.log(`[PASS] 4. 本机 Chrome 离线 PDF 生成验证通过 (${fs.statSync(pdfResult.pdfPath).size} bytes)`);

  // 5. 测试状态流转与复盘统计
  await fetch(`${baseUrl}/api/jobs/${job.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'interview', notes: '一面很顺利' }),
  });
  const reviewResp = await fetch(`${baseUrl}/api/review`);
  const review = await reviewResp.json();
  assert.equal(review.funnel.sent, 1);
  assert.equal(review.funnel.interview, 1);
  assert.equal(review.funnel.interviewRate, 100);

  const stateResp = await fetch(`${baseUrl}/api/state`);
  const state = await stateResp.json();
  assert.ok(state.auditLogs.length >= 1, '隐私审计日志未记录');
  console.log('[PASS] 5. 状态流转、复盘漏斗与隐私外发审计验证通过');

  // 6. 测试 .docx 离线简历上传解析（含公司嵌套多段子项目）、模式 B 脱敏简历整理与主简历预览
  const docxXml = `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>林示例</w:t></w:r></w:p>
        <w:p><w:r><w:t>30岁 ｜ 硕士 ｜ 6年后端研发经验</w:t></w:r></w:p>
        <w:p><w:r><w:t>求职方向：后端架构师 ｜ 期望城市：北京 ｜ 13800138001 ｜ demo@example.com</w:t></w:r></w:p>
        <w:p><w:r><w:t>个人优势</w:t></w:r></w:p>
        <w:p><w:r><w:t>· 6年高并发分布式系统与云原生平台架构经验。</w:t></w:r></w:p>
        <w:p><w:r><w:t>· 主导核心订单链路重构，峰值 QPS 提升 3 倍。</w:t></w:r></w:p>
        <w:p><w:r><w:t>工作经历</w:t></w:r></w:p>
        <w:p><w:r><w:t>示例科技公司A　后端技术负责人 | 2020.06 - 2023.06</w:t></w:r></w:p>
        <w:p><w:r><w:t>订单中心核心重构项目　架构主管 | 2022.01 - 2023.06</w:t></w:r></w:p>
        <w:p><w:r><w:t>· 负责订单中心分库分表与高可用治理，接口 P99 延迟下降 45%。</w:t></w:r></w:p>
        <w:p><w:r><w:t>支付网关升级项目　架构主管 | 2020.06 - 2021.12</w:t></w:r></w:p>
        <w:p><w:r><w:t>· 负责多渠道结算网关重构，显著提升系统吞吐与稳定性。</w:t></w:r></w:p>
        <w:p><w:r><w:t>示例网络有限公司　后端开发工程师 | 2018.07 - 2020.05</w:t></w:r></w:p>
        <w:p><w:r><w:t>· 负责核心微服务接口设计与性能优化。</w:t></w:r></w:p>
        <w:p><w:r><w:t>核心能力</w:t></w:r></w:p>
        <w:p><w:r><w:t>后端架构：分布式系统｜高并发治理｜云原生</w:t></w:r></w:p>
        <w:p><w:r><w:t>工程管理：代码规范｜性能压测｜项目统筹</w:t></w:r></w:p>
      </w:body>
    </w:document>`;
  const docxBase64 = buildMinimalDocxBuffer(docxXml).toString('base64');

  const parseResp = await fetch(`${baseUrl}/api/settings/resume/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'my_resume.docx', contentBase64: docxBase64 }),
  });
  assert.equal(parseResp.status, 200);
  const parsedData = await parseResp.json();
  assert.equal(parsedData.resume.headline, '后端架构师');
  assert.ok(parsedData.resume.basicInfo.includes('6年后端研发经验'), '未提取一句话基本信息栏');
  assert.equal(parsedData.resume.experiences.length, 2, '应合并为 2 家公司经历');
  assert.equal(parsedData.resume.experiences[0].company, '示例科技公司A');
  assert.equal(parsedData.resume.experiences[0].role, '后端技术负责人');
  assert.equal(parsedData.resume.experiences[0].subProjects.length, 2, '父公司下应自动挂载 2 段子项目');
  assert.equal(parsedData.resume.experiences[0].subProjects[0].name, '订单中心核心重构项目');
  assert.equal(parsedData.resume.experiences[0].subProjects[1].name, '支付网关升级项目');
  assert.equal(parsedData.resume.skills.length, 2, '核心能力板块应正确提取');
  assert.ok(!JSON.stringify(parsedData.resume).includes('13800138001'), '解析结果不应包含手机号');

  const resumeExportResp = await fetch(`${baseUrl}/api/settings/resume/collab-export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawText: parsedData.rawText }),
  });
  assert.equal(resumeExportResp.status, 200);
  const resumeExport = await resumeExportResp.json();
  const resumeTaskText = fs.readFileSync(resumeExport.taskPath, 'utf8');
  assert.ok(!resumeTaskText.includes('13800138001'), '模式 B 简历任务包泄露手机号');
  assert.ok(!resumeTaskText.includes('示例科技公司A'), '模式 B 简历任务包未脱敏自定义公司名');

  const resumeImportResp = await fetch(`${baseUrl}/api/settings/resume/collab-import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resultText: JSON.stringify({
        headline: '后端架构师',
        basicInfo: '30岁 ｜ 硕士 ｜ 6年后端研发经验',
        summary: '6年高并发分布式系统经验\n核心链路 QPS 提升 3 倍',
        skills: ['后端架构：分布式系统｜高并发治理', '工程管理：性能压测｜项目统筹'],
        experiences: [
          {
            company: '{{SENSITIVE_1}}',
            role: '后端技术负责人',
            period: '2020.06 - 2023.06',
            highlights: [],
            subProjects: [
              {
                name: '订单中心核心重构项目',
                role: '架构主管',
                period: '2022.01 - 2023.06',
                highlights: ['主导订单链路重构，接口 P99 延迟下降 45%'],
              },
            ],
          },
        ],
        projects: [],
        education: [],
      }),
    }),
  });
  assert.equal(resumeImportResp.status, 200);
  const resumeImported = await resumeImportResp.json();
  assert.equal(resumeImported.masterResume.experiences[0].company, '示例科技公司A');
  assert.equal(resumeImported.masterResume.experiences[0].subProjects[0].name, '订单中心核心重构项目');

  const previewResp = await fetch(`${baseUrl}/api/settings/resume/preview`);
  assert.equal(previewResp.status, 200);
  const previewHtml = await previewResp.text();
  assert.ok(previewHtml.includes('后端架构师'), '主简历预览未渲染更新后的标题');
  assert.ok(previewHtml.includes('订单中心核心重构项目'), '主简历预览未渲染嵌套子项目');

  // 6.2 用第 4 步本机 Chrome 真实渲染的中文 PDF 测试直接上传 .pdf 离线解析
  const pdfBase64 = fs.readFileSync(pdfResult.pdfPath).toString('base64');
  const pdfParseResp = await fetch(`${baseUrl}/api/settings/resume/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'test_resume.pdf', contentBase64: pdfBase64 }),
  });
  assert.equal(pdfParseResp.status, 200, 'PDF 简历上传解析接口返回失败');
  const pdfParsed = await pdfParseResp.json();
  assert.ok(pdfParsed.rawText.includes('高级前端开发工程师') || pdfParsed.rawText.includes('Vue'), '真实中文 PDF 文本提取未命中核心中文内容');
  assert.ok(!JSON.stringify(pdfParsed.resume).includes('13800138001'), 'PDF 解析结果不应保留隐私手机号');
  console.log('[PASS] 6. .pdf 与 .docx 离线简历上传解析、模式 B 脱敏整理与主简历预览验证通过');

  // 7. 测试面试题库预测、模拟面试、聊天回复与本地谈薪计算器
  const prepExportResp = await fetch(`${baseUrl}/api/jobs/${job.id}/interview-prep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'collab' }),
  });
  assert.equal(prepExportResp.status, 200);
  const prepExport = await prepExportResp.json();
  assert.ok(!fs.readFileSync(prepExport.taskPath, 'utf8').includes('13800138001'), '面试题任务包泄露隐私');

  const prepImportResp = await fetch(`${baseUrl}/api/jobs/${job.id}/interview-prep/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resultText: JSON.stringify({
        questions: [
          {
            id: 'q1',
            category: '核心业务深挖',
            question: '请复盘你最有代表性的一次增长项目',
            intent: '考察拆解与拿结果能力',
            answer: '在{{SENSITIVE_1}}期间主导重构，首屏耗时降至0.9s。',
            pitfalls: '避免只讲背景不讲量化结果',
          },
        ],
        reverse_questions: [{ question: '团队本季度核心业务目标是什么？', purpose: '了解业务优先级' }],
      }),
    }),
  });
  assert.equal(prepImportResp.status, 200);
  const prepImported = await prepImportResp.json();
  assert.ok(prepImported.prep.questions[0].answer.includes('示例科技公司A'), '面试题答案未本地还原敏感词');

  const startMockResp = await fetch(`${baseUrl}/api/jobs/${job.id}/mock-interview/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: '业务负责人/副总' }),
  });
  assert.equal(startMockResp.status, 201);
  const { session } = await startMockResp.json();
  assert.equal(session.messages.length, 1);

  const turnExportResp = await fetch(`${baseUrl}/api/coach/sessions/${session.id}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'collab', answer: '我主要从性能和转化两方面推进，把首屏优化到了0.9s。' }),
  });
  assert.equal(turnExportResp.status, 200);

  const turnImportResp = await fetch(`${baseUrl}/api/coach/sessions/${session.id}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resultText: JSON.stringify({
        score: 84,
        dimensions: { depth: '抓住了关键指标', logic: '较清晰', data: '有核心数据支撑' },
        strengths: ['直接给结果'],
        improvements: ['可补充具体业务收益'],
        better_answer: '可补充续费率提升12%的业务闭环结果。',
        next_question: '如果研发资源紧张，你如何排期取舍？',
      }),
    }),
  });
  assert.equal(turnImportResp.status, 200);
  const turnImported = await turnImportResp.json();
  assert.equal(turnImported.session.messages.length, 4);

  const quickChatResp = await fetch(`${baseUrl}/api/jobs/${job.id}/chat-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'quick', scenario: '核实双休与福利', hrMessage: '方便聊聊吗' }),
  });
  assert.equal(quickChatResp.status, 200);
  const quickChat = await quickChatResp.json();
  assert.ok(quickChat.replies.length >= 2, '本地快捷聊天回复不足');

  const smartChatResp = await fetch(`${baseUrl}/api/jobs/${job.id}/chat-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'quick',
      scenario: '自动识别',
      hrMessage: '我们这边底薪15K绩效5K，试用期打八折，你能接受吗？',
    }),
  });
  assert.equal(smartChatResp.status, 200);
  const smartChat = await smartChatResp.json();
  assert.equal(smartChat.detectedScenario, '应对压薪或试用期打折', 'HR 原话意图自动识别失败');
  assert.ok(smartChat.analysis && smartChat.analysis.length > 5, '缺少 HR 意图剖析');
  assert.ok(smartChat.replies.length >= 3, '智能聊天回复应不少于 3 条');
  assert.ok(smartChat.usedResume, '本地聊天回复未融合主简历真实信息');

  const salaryPatchResp = await fetch(`${baseUrl}/api/jobs/${job.id}/interview-prep`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salary_plan: { targetMonthlyK: 22, floorMonthlyK: 18, months: 13, performanceRatio: 20 } }),
  });
  assert.equal(salaryPatchResp.status, 200);
  const salaryData = await salaryPatchResp.json();
  assert.equal(salaryData.salary.plan.targetMonthlyK, 22);
  assert.ok(salaryData.salary.playbooks.length === 6, '谈薪剧本数量异常');
  console.log('[PASS] 7. 面试题预测、模拟面试逐轮点评、聊天回复与谈薪计算器验证通过');

  // 8. 测试 8 大岗位模板一键载入（含 AI / 主播 / 应届生）、6 维反问清单、职业规划模块与 PWA manifest
  const tplLoadResp = await fetch(`${baseUrl}/api/jobs/${job.id}/interview-prep/template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateId: 'live_host' }),
  });
  assert.equal(tplLoadResp.status, 200);
  const tplData = await tplLoadResp.json();
  assert.ok(tplData.prep.questions.length >= 2, '岗位模板题库载入失败');
  assert.equal(tplData.coach.allTemplates.length, 13, '内置全行业岗位模板数量不符');
  assert.equal(tplData.coach.reverseChecklist.length, 6, '应包含 6 大维度面试者反向考察清单');
  assert.ok(tplData.coach.roleTemplate.salaryStructure.typical.includes('佣金'), '主播薪资结构指南未切换');

  // 验证多行业自动匹配准确性（AI / Java研发 / 财务 / HR / UI设计 / 应届生）及每岗至少 14 道深度题
  const { ROLE_TEMPLATES, detectRoleTemplate, getFullQuestionsForTemplate } = await import('./role-templates.mjs');
  for (const tpl of ROLE_TEMPLATES) {
    const fullQs = getFullQuestionsForTemplate(tpl.id);
    assert.ok(fullQs.length >= 15, `行业模板 ${tpl.id} 题量不足 15 道，当前仅 ${fullQs.length} 道`);
  }
  assert.equal(detectRoleTemplate('AI Agent 应用工程师', '').id, 'ai_role');
  assert.equal(detectRoleTemplate('Java 后端开发工程师', '').id, 'tech_dev');
  assert.equal(detectRoleTemplate('数据分析师 BI', '').id, 'data_analyst');
  assert.equal(detectRoleTemplate('UI 视觉设计师', '').id, 'design_creative');
  assert.equal(detectRoleTemplate('财务会计', '').id, 'finance_legal');
  assert.equal(detectRoleTemplate('HRBP 招聘经理', '').id, 'hr_admin');
  assert.equal(detectRoleTemplate('2026届应届生管培生', '').id, 'fresh_grad_general');

  const careerQuickResp = await fetch(`${baseUrl}/api/career/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'quick',
      planType: 'explore',
      careerStage: 'fresh_grad',
      targetRole: 'AI 产品经理',
      interests: 'AI应用落地',
    }),
  });
  assert.equal(careerQuickResp.status, 201);
  const careerQuick = await careerQuickResp.json();
  assert.ok(careerQuick.careerPlan.plan.recommended_directions.length >= 3, '应届生方向探索应返回多条路线');
  assert.ok(careerQuick.careerPlan.plan.skill_gaps.length >= 3, '技能缺口与练习方案生成失败');

  const careerExportResp = await fetch(`${baseUrl}/api/career/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'collab', planType: 'skill_upgrade', careerStage: 'mid_career', targetRole: 'AI 应用工程师' }),
  });
  assert.equal(careerExportResp.status, 200);
  const careerExport = await careerExportResp.json();
  assert.ok(!fs.readFileSync(careerExport.taskPath, 'utf8').includes('13800138001'), '职业规划脱敏包泄露隐私');

  const manifestResp = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResp.status, 200);
  const manifestJson = await manifestResp.json();
  assert.equal(manifestJson.display, 'standalone');

  const mobileGenericResp = await fetch(`${baseUrl}/api/export/mobile-html?mode=generic`);
  assert.equal(mobileGenericResp.status, 200);
  const mobileGenericHtml = await mobileGenericResp.text();
  assert.ok(mobileGenericHtml.includes('JobMate-AI'), '通用在线版标题缺失');
  assert.ok(mobileGenericHtml.includes('sub-jobs-resume'), '一级显眼简历底稿入口缺失');
  assert.ok(mobileGenericHtml.includes('viewBox="0 0 24 24"'), '线性 SVG 图标缺失');
  assert.ok(!mobileGenericHtml.includes('📋') && !mobileGenericHtml.includes('🎯'), '在线版仍有未清理的原生 Emoji');
  assert.ok(!mobileGenericHtml.includes('示例互娱'), '纯净通用版不应包含任何个人岗位');
  assert.ok(!mobileGenericHtml.includes('13800138001'), '纯净通用版不应包含隐私手机号');
  assert.ok(!mobileGenericHtml.includes('示例科技公司A'), '纯净通用版不应包含个人公司经历');

  const mobilePersonalResp = await fetch(`${baseUrl}/api/export/mobile-html?mode=personal`);
  assert.equal(mobilePersonalResp.status, 200);
  const mobilePersonalHtml = await mobilePersonalResp.text();
  assert.ok(mobilePersonalHtml.includes('示例互娱'), '个人手机离线版应包含个人岗位');
  assert.ok(!mobilePersonalHtml.includes('13800138001'), '个人手机离线版不应包含隐私手机号');
  assert.ok(mobileGenericHtml.includes('runMobileTierRecommend'), '线上通用版缺少三档推荐入口');
  assert.ok(mobileGenericHtml.includes('moveMobileRecTier'), '线上通用版缺少三档调档交互');
  assert.ok(mobileGenericHtml.includes('removeMobileRecItem'), '线上通用版缺少推荐岗位移除交互');
  assert.ok(mobileGenericHtml.includes('importMobileCollabRecJson'), '线上通用版缺少模式 B 批量追加导入交互');
  assert.ok(mobileGenericHtml.includes('generateMobileSmartChatReply'), '线上通用版缺少结合简历生成 HR 回复逻辑');
  assert.ok(mobileGenericHtml.includes('jumpToJobChatReply'), '线上通用版缺少岗位卡片直达回复 HR 按钮');
  assert.ok(mobileGenericHtml.includes('m-chat-hr-msg'), '线上通用版缺少 HR 原话粘贴框');
  console.log('[PASS] 8. 多岗位模板库、6维反问、职业规划、PWA及纯净通用/个人双版手机导出验证通过');

  // 9. 测试三档精准推荐分类算法 + 一键采纳候选岗位直接生成专属简历与 3 套打招呼话术
  const { classifyAndScoreCandidates, deriveProfileSignals } = await import('./job-finder.mjs');
  const demoSignals = deriveProfileSignals(resumeImported.masterResume, { city: '北京', targetSalaryK: 25 });
  const multiCandidates = [
    { id: 'c1', platform: '全网公开招聘', source: 'jobui', company: '示例初创科技', title: '后端开发工程师', city: '北京', salary: '16-20K', experience: '1-3年', education: '本科', companyMeta: '50-99人', url: 'https://example.com/1', jd_text: '负责后端接口开发与维护' },
    { id: 'c2', platform: '全网公开招聘', source: 'jobui', company: '示例微云软件', title: '后端工程师', city: '北京', salary: '15-19K', experience: '1-3年', education: '大专', companyMeta: '20-99人', url: 'https://example.com/2', jd_text: '负责业务接口开发与数据库维护' },
    { id: 'c3', platform: '全网公开招聘', source: 'jobui', company: '示例星河信息', title: 'Java后端开发', city: '北京', salary: '18-22K', experience: '2年', education: '本科', companyMeta: '100-499人', url: 'https://example.com/3', jd_text: '负责核心业务接口与系统稳定' },
    { id: 'c4', platform: '全网公开招聘', source: 'jobui', company: '示例云联网络', title: '后端架构师', city: '北京', salary: '24-32K', experience: '5年', education: '本科', companyMeta: '500-999人', url: 'https://example.com/4', jd_text: '负责分布式系统与高并发架构治理' },
    { id: 'c5', platform: '全网公开招聘', source: 'jobui', company: '示例智算科技', title: '高级后端开发', city: '北京', salary: '23-30K', experience: '3-5年', education: '本科', companyMeta: '500-999人', url: 'https://example.com/5', jd_text: '负责订单中心与高并发核心链路' },
    { id: 'c6', platform: '全网公开招聘', source: 'jobui', company: '示例数字引擎', title: '资深后端研发', city: '北京', salary: '25-33K', experience: '5年', education: '本科', companyMeta: '1000-9999人', url: 'https://example.com/6', jd_text: '负责中台服务治理与性能优化' },
    { id: 'c7', platform: '全网公开招聘', source: 'jobui', company: '示例大型集团股份有限公司', title: '首席后端架构总监', city: '北京', salary: '40-55K', experience: '8-10年', education: '博士', companyMeta: '10000人以上', url: 'https://example.com/7', jd_text: '负责万人级平台核心架构与团队管理' },
    { id: 'c8', platform: '全网公开招聘', source: 'jobui', company: '示例未来上市科技集团', title: '技术架构负责人', city: '北京', salary: '35-48K', experience: '8年', education: '硕士', companyMeta: '10000人以上', url: 'https://example.com/8', jd_text: '负责万人平台稳定性架构演进' },
    { id: 'c9', platform: '全网公开招聘', source: 'jobui', company: '示例领航互联网', title: '后端架构专家', city: '北京', salary: '32-45K', experience: '6年', education: '硕士', companyMeta: '1000-9999人', url: 'https://example.com/9', jd_text: '负责核心架构升级与跨团队赋能' },
  ];
  const demoTiers = classifyAndScoreCandidates(multiCandidates, demoSignals, { perTierLimit: 5 });
  assert.ok(demoTiers.practice.length >= 2, `三档推荐练手档应>=2个，当前为 ${demoTiers.practice.length}`);
  assert.ok(demoTiers.core.length >= 2, `三档推荐主力档应>=2个，当前为 ${demoTiers.core.length}`);
  assert.ok(demoTiers.stretch.length >= 2, `三档推荐进阶档应>=2个，当前为 ${demoTiers.stretch.length}`);

  const excludedTiers = classifyAndScoreCandidates(multiCandidates, demoSignals, {
    perTierLimit: 5,
    excludeKeys: ['示例初创科技|后端开发工程师', '示例云联网络|后端架构师'],
  });
  const allExcludedIds = [...excludedTiers.practice, ...excludedTiers.core, ...excludedTiers.stretch].map((x) => x.id);
  assert.ok(!allExcludedIds.includes('c1') && !allExcludedIds.includes('c4'), 'excludeKeys 未过滤已排除岗位');

  // 验证模式 B 导入联网岗位 JSON 并自动三档分类接口
  const importRecResp = await fetch(`${baseUrl}/api/jobs/recommend/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      city: '北京',
      targetSalaryK: 25,
      resultText: JSON.stringify([
        { company: '示例初创科技', title: '后端开发工程师', city: '北京', salary: '16-20K', experience: '1-3年', education: '本科', jd_text: '负责后端接口开发' },
        { company: '示例云联网络', title: '后端架构师', city: '北京', salary: '24-32K', experience: '5年', education: '本科', jd_text: '负责分布式高并发架构' },
        { company: '示例大型集团股份有限公司', title: '首席后端架构总监', city: '北京', salary: '40-55K', experience: '8-10年', education: '博士', jd_text: '负责万人平台核心架构' },
      ]),
    }),
  });
  assert.equal(importRecResp.status, 200, '模式 B 联网搜岗导入接口失败');
  const importRecData = await importRecResp.json();
  assert.equal(importRecData.totalRecommended, 3, '模式 B 导入应成功分类 3 个岗位');

  const adoptResp = await fetch(`${baseUrl}/api/jobs/adopt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidates: [demoTiers.core[0], demoTiers.stretch[0]],
      useApi: false,
      generatePdf: true,
    }),
  });
  assert.equal(adoptResp.status, 201, '一键采纳推荐岗位接口失败');
  const adoptedData = await adoptResp.json();
  assert.equal(adoptedData.count, 2, '应成功采纳 2 个推荐岗位');
  for (const item of adoptedData.adopted) {
    assert.ok(['practice', 'core', 'stretch'].includes(item.job.tier), '未保存岗位三档标签');
    assert.ok(item.job.tailored_resume && item.job.tailored_resume.experiences.length >= 1, '未自动生成专属定制简历');
    assert.ok(Array.isArray(item.job.greetings) && item.job.greetings.length === 3, '未自动生成 3 套打招呼话术');
    assert.ok(item.job.selected_greeting.length > 20, '未自动填入默认打招呼话术');
    assert.ok(item.job.resume_pdf_path && fs.existsSync(item.job.resume_pdf_path), '未自动渲染专属 PDF 简历');
  }
  console.log('[PASS] 9. 三档精准推荐分类与一键采纳自动生成专属简历、3套话术及PDF验证通过');

  console.log('ALL TESTS PASSED!');
} finally {
  if (server) server.close();
  closeDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
}
