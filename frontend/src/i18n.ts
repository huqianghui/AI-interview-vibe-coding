/**
 * i18next setup — zh-CN + en-US (SPEC: bilingual interview support).
 *
 * Step 0 ships a small UI-string catalog inline. Later features can split resources into
 * per-namespace JSON; the detection order (localStorage → browser) and fallback stay here.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export const resources = {
  "en-US": {
    translation: {
      appTitle: "AI Interview",
      tagline: "SOP-traceable, digital-human interviewing",
      start: "Start interview",
      starting: "Starting…",
      submit: "Submit answer",
      submitting: "Submitting…",
      finish: "Finish & get report",
      questionProgress: "Question {{index}} of {{total}}",
      answerPlaceholder: "Type your answer…",
      reportTitle: "Interview report (placeholder)",
      coverage: "Coverage",
      stubNote: "Stub scoring — not yet SOP-graded.",
      language: "Language",
      orientation: {
        title: "Before we begin",
        body: "You'll answer {{total}} questions. Take your time — you can speak or type, and you decide when each answer is finished.",
        begin: "I'm ready",
      },
      noQuestions: {
        title: "No questions available",
        body: "This interview has no questions configured yet. Please check back once a question bank is set up.",
      },
      // External-brain interview phases (Phase 2). Vendor-neutral copy — never names a product.
      // "thinking" is the awaiting overlay while the external interviewer produces the next turn;
      // "recovery" clears a stalled turn; "complete" replaces the local report with an
      // acknowledgement (external sessions are scored by the organizer, not shown here — SPEC P12).
      external: {
        thinking: "Interviewer is thinking…",
        recoveryTitle: "This turn was interrupted",
        recoveryBody:
          "The connection to the interviewer stalled. Your last answer was saved — resume to continue where you left off.",
        recover: "Resume",
        recovering: "Resuming…",
        completeTitle: "Interview complete",
        completeBody:
          "This interview has ended. The organizer will follow up with you separately about the results.",
      },
      voice: {
        idle: "Ready",
        listening: "Listening…",
        speaking: "Speaking…",
        muted: "Muted",
        useVoice: "Answer by voice",
        useText: "Answer by text",
        connecting: "Connecting to the interviewer…",
        reconnecting: "Connection dropped — reconnecting…",
        stillListening: "Still listening… take your time",
        mute: "Mute",
        unmute: "Unmute",
        imDone: "I'm done answering",
        emptyAnswer:
          'We didn\'t catch an answer — please speak, then tap "I\'m done answering" again.',
        endedFallback: "Voice unavailable — you can continue by text.",
        transcriptEmpty: "The conversation will appear here as you speak.",
        roleYou: "You",
        roleInterviewer: "Interviewer",
        statusLegendLabel: "Voice status",
        statusTips: {
          idle: "Ready — the interviewer is waiting for you to start speaking.",
          listening: "Listening — your voice is being picked up; speak naturally.",
          speaking: "Speaking — the interviewer is talking; listen, then reply.",
          muted: "Muted — your mic is off. Tap Unmute to be heard.",
        },
      },
      micDialog: {
        title: "Microphone access needed",
        body: "To answer by voice, allow microphone access in your browser. You can also continue by text.",
        stillDenied: "Still blocked. Check your browser's site permissions, or continue by text.",
        retry: "Try again",
        useTextInstead: "Use text instead",
      },
      transition: {
        scoring: "Analyzing answer {{n}} of {{total}} against the SOP…",
        reportReady: "Your report is ready.",
      },
      report: {
        title: "Interview report",
        sopSource: "SOP source",
        // Clickable citation: tooltip/aria on the source link, and the transient "opening…" and
        // failure states while the document is fetched.
        openSource: "Open source document",
        openingSource: "Opening…",
        openSourceFailed: "Couldn't open the source document.",
        candidateAnswer: "Candidate answer",
        showDetail: "Show detailed breakdown",
        hideDetail: "Hide detailed breakdown",
        questionN: "Question {{n}}",
        weight: "weight",
        judgment: {
          met: "Met",
          partially_met: "Partially met",
          not_met: "Not met",
          violated: "Violated",
        },
        // Classification rating (the executive headline) + the two explanatory notes.
        outcomeLabel: "Overall rating",
        outcome: {
          "Meets Expectations": "Meets Expectations",
          "Needs Improvement": "Needs Improvement",
          "Does Not Meet": "Does Not Meet",
        },
        cappedNote:
          "Capped to Needs Improvement: a critical error was confirmed against the authoritative SOP.",
        disclosure: "Disclosure",
        disclosureNote:
          "A known source conflict was raised. It is disclosed for transparency and does not reduce the score.",
        // Feature D (opt-in) advisory panel: SOP points the checklist may not cover. Reference-only.
        sopCoverage: {
          title: "SOP coverage notes",
          hint: "For reference only — SOP points the checklist may not fully cover. These do not affect your score.",
        },
      },
      review: {
        title: "Review your answers",
        body: "You've answered every question. Read them over — when you're ready, submit to start SOP-based scoring.",
        action: "Submit & evaluate",
        // Feature D opt-in: default off. Ticking it runs an advisory SOP-coverage audit.
        sopCoverageCheck: {
          label: "Also run an SOP coverage check",
          hint: "Optional. Compares your checklist against the original SOP and flags points it may not cover — added to the report for reference only. It does not affect your score and takes a little longer.",
        },
      },
      // Admin surfaces (/admin, /admin/agent). Single-language: driven by the header selector, so
      // English shows only English (was previously hardcoded "中文 / English" bilingual strings).
      admin: {
        checkingAuth: "Verifying your session…",
        username: "Username",
        password: "Password",
        login: "Sign in",
        errAdminRequired: "Administrator access required",
        loginTitle: "Admin sign-in",
        loginBody: "Sign in with an admin account to edit question banks, rubrics, and configuration.",
        pageTitle: "Admin — Question banks & rubrics",
        navAgent: "Digital-human editor →",
        tabContent: "Content",
        tabConnection: "Azure connection",
        banksTitle: "Question banks",
        defaultBadge: "default",
        makeDefault: "Make default",
        newBankPlaceholder: "New bank name",
        addBank: "Add bank",
        questionsTitle: "Questions",
        rubricItems: "✓ {{count}} items",
        rubricNotConfigured: "⚙ Not configured",
        rubricBtn: "Rubric",
        moveUp: "Move up",
        delete: "Delete",
        newQuestionPlaceholder: "New question text",
        addQuestion: "Add question",
        selectBankHint: "Select a bank to view its questions.",
        rubricTitle: "Scoring rubric",
        weightsTotal: "Weights total: {{sum}} — {{count}} items",
        weightsHint: " (re-normalized to 100 on save)",
        rubricItemPlaceholder: "Rubric item text",
        noRubric:
          "No rubric for this question yet — generate one from the question, or add items manually.",
        addItem: "Add item",
        save: "Save",
        generateAi: "Generate (AI)",
        saved: "Saved",
        generated: "Generated",
        agentLoginTitle: "Agent editor sign-in",
        agentLoginBody: "Sign in with an admin account to edit the interviewer agent.",
      },
    },
  },
  "zh-CN": {
    translation: {
      appTitle: "AI 面试",
      tagline: "可溯源 SOP、数字人面试",
      start: "开始面试",
      starting: "开始中…",
      submit: "提交回答",
      submitting: "提交中…",
      finish: "结束并生成报告",
      questionProgress: "第 {{index}} 题 / 共 {{total}} 题",
      answerPlaceholder: "输入你的回答…",
      reportTitle: "面试报告(占位)",
      coverage: "覆盖率",
      stubNote: "占位评分 —— 尚未按 SOP 评分。",
      language: "语言",
      orientation: {
        title: "开始之前",
        body: "你将回答 {{total}} 道题。不用着急 —— 可以语音或打字作答，每题何时答完由你决定。",
        begin: "我准备好了",
      },
      noQuestions: {
        title: "暂无可用题目",
        body: "本次面试尚未配置题目。请在题库配置完成后再来。",
      },
      // 外部大脑面试的各阶段（Phase 2）。文案保持中立 —— 不出现任何产品名。
      // thinking = 等待外部面试官产出下一轮时的遮罩；recovery = 清除中断的一轮；
      // complete = 用致谢替代本地报告（外部场次由主办方评分，此处不展示 —— SPEC P12）。
      external: {
        thinking: "面试官思考中…",
        recoveryTitle: "本轮对话被中断",
        recoveryBody: "与面试官的连接暂时中断，你上一次的回答已保存 —— 点击「恢复」即可继续。",
        recover: "恢复",
        recovering: "正在恢复…",
        completeTitle: "面试已结束",
        completeBody: "本场面试已结束，结果将由主办方另行联系。",
      },
      voice: {
        idle: "就绪",
        listening: "聆听中…",
        speaking: "回应中…",
        muted: "已静音",
        useVoice: "语音作答",
        useText: "文字作答",
        connecting: "正在连接面试官…",
        reconnecting: "连接中断 —— 正在重连…",
        stillListening: "仍在聆听… 请慢慢说",
        mute: "静音",
        unmute: "取消静音",
        imDone: "我答完了",
        emptyAnswer: "我们没有听到你的回答 —— 请说话后再次点击「我答完了」。",
        endedFallback: "语音不可用 —— 你可以改用文字继续。",
        transcriptEmpty: "对话内容将在你发言时显示在这里。",
        roleYou: "你",
        roleInterviewer: "面试官",
        statusLegendLabel: "语音状态",
        statusTips: {
          idle: "就绪 —— 面试官在等你开始说话。",
          listening: "聆听中 —— 正在采集你的声音，自然作答即可。",
          speaking: "回应中 —— 面试官正在说话，听完再回答。",
          muted: "已静音 —— 你的麦克风已关闭，点「取消静音」即可发声。",
        },
      },
      micDialog: {
        title: "需要麦克风权限",
        body: "语音作答需要在浏览器中允许麦克风访问。你也可以改用文字继续。",
        stillDenied: "仍被阻止。请检查浏览器的站点权限，或改用文字继续。",
        retry: "重试",
        useTextInstead: "改用文字",
      },
      transition: {
        scoring: "正在按 SOP 分析第 {{n}} / {{total}} 个回答…",
        reportReady: "你的报告已就绪。",
      },
      report: {
        title: "面试报告",
        sopSource: "SOP 出处",
        // 可点击引用：来源链接的提示/aria 文案，以及抓取文件期间的“打开中”与失败状态。
        openSource: "打开来源文件",
        openingSource: "打开中…",
        openSourceFailed: "无法打开来源文件。",
        candidateAnswer: "候选人回答",
        showDetail: "展开详细拆解",
        hideDetail: "收起详细拆解",
        questionN: "第 {{n}} 题",
        weight: "权重",
        judgment: {
          met: "达标",
          partially_met: "部分达标",
          not_met: "未达标",
          violated: "违规",
        },
        // 分类评级(报告 headline)+ 两条说明注记。
        outcomeLabel: "总体评价",
        outcome: {
          "Meets Expectations": "达到预期",
          "Needs Improvement": "有待改进",
          "Does Not Meet": "未达预期",
        },
        cappedNote: "已封顶为「有待改进」:回答中存在与权威 SOP 冲突的关键错误。",
        disclosure: "披露",
        disclosureNote: "已提示一处已知的资料冲突。此处仅作透明披露,不影响评分。",
        // 功能 D(可选)提示板块:评价标准可能未覆盖的 SOP 要点,仅作参考。
        sopCoverage: {
          title: "SOP 原文覆盖度提示",
          hint: "仅供参考 —— 列出评价标准可能未完全覆盖的 SOP 要点。这些内容不影响你的评分。",
        },
      },
      review: {
        title: "回顾你的回答",
        body: "你已回答完所有问题。请整体回顾一遍 —— 准备好后,点击提交即可开始按 SOP 评测。",
        action: "提交并评测",
        // 功能 D 可选项:默认关闭。勾选后额外做一次 SOP 原文覆盖度体检(仅作提示)。
        sopCoverageCheck: {
          label: "同时进行 SOP 原文覆盖度体检",
          hint: "可选项。将本次评价标准与 SOP 原文比对,标出可能未覆盖的要点,追加到报告中仅供参考。不影响你的评分,且会略微增加耗时。",
        },
      },
      // 管理端(/admin、/admin/agent)。单语:由页头语言选择器驱动,选中文时只显示中文
      //(此前是硬编码的「中文 / English」双语拼接串)。
      admin: {
        checkingAuth: "正在验证登录状态…",
        username: "用户名",
        password: "密码",
        login: "登录",
        errAdminRequired: "需要管理员权限",
        loginTitle: "Admin 登录",
        loginBody: "用管理员账号登录以编辑题库、清单与配置。",
        pageTitle: "Admin — 题库与评分标准",
        navAgent: "数字人编辑 →",
        tabContent: "题库与评分标准",
        tabConnection: "Azure 连接",
        banksTitle: "题库",
        defaultBadge: "默认",
        makeDefault: "设为默认",
        newBankPlaceholder: "新题库名称",
        addBank: "添加题库",
        questionsTitle: "题目",
        rubricItems: "✓ {{count}} 项",
        rubricNotConfigured: "⚙ 未配评分",
        rubricBtn: "评分标准",
        moveUp: "上移",
        delete: "删除",
        newQuestionPlaceholder: "新题目",
        addQuestion: "添加题目",
        selectBankHint: "选择一个题库以查看题目。",
        rubricTitle: "评分标准",
        weightsTotal: "权重合计: {{sum}} — {{count}} 项",
        weightsHint: " (保存后按 100 归一)",
        rubricItemPlaceholder: "评分要点",
        noRubric: "这道题还没有评分标准。点「重新生成 (AI)」从题目自动起草,或手动添加条目。",
        addItem: "添加一条",
        save: "保存",
        generateAi: "重新生成 (AI)",
        saved: "已保存",
        generated: "已生成",
        agentLoginTitle: "Agent editor 登录",
        agentLoginBody: "用管理员账号登录以编辑面试官 agent。",
      },
    },
  },
} as const;

export const SUPPORTED_LANGUAGES = ["zh-CN", "en-US"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const stored =
  typeof localStorage !== "undefined" ? localStorage.getItem("lang") : null;

void i18n.use(initReactI18next).init({
  resources,
  lng: stored ?? "en-US",
  fallbackLng: "en-US",
  interpolation: { escapeValue: false },
});

export default i18n;
