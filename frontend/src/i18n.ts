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
      // The same sentence as `tagline`, split into three clauses so the sign-in screen can set it
      // as a display headline with the middle clause in the accent colour (approved direction
      // D-purple). Split rather than interpolated with markup so each clause stays translatable on
      // its own — a translator can reorder the clauses without touching the component.
      taglineLead: "SOP-traceable,",
      taglineAccent: "digital-human",
      taglineTail: "interviewing",
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
        // External mode exposes no fixed question count (the interviewer drives the flow turn by
        // turn), so the count-based copy above would read "0 questions" — this variant drops it.
        bodyExternal:
          "The interviewer will guide you through the conversation. Take your time — you can speak or type, and you decide when each answer is finished.",
        begin: "I'm ready",
        // The one thing this screen knows that the idle screen could not: the question count.
        headlineLead: "{{total}} questions,",
        headlineAccent: "at your pace",
        lede: "Lisa will ask each one out loud. The question stays on screen the whole time, so you can re-read it while you think.",
        railLabel: "The interview at a glance",
        fact1Title: "Answer however suits you",
        fact1Body: "Speak or type, and switch between them whenever you like.",
        fact2Title: "Say when you're done",
        fact2Body: "Each answer is submitted only when you say it's finished.",
        beginNote: "Question 1 starts as soon as you press this.",
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
        voiceOnlyNotice: "Weak network — voice only",
        hideAvatar: "Turn off video",
        showAvatar: "Turn on video",
        showAvatarCooldown: "Video can be turned back on again shortly.",
        showAvatarCooldownSeconds: "Video can be turned back on in about {{seconds}}s.",
        endedFallback: "Voice unavailable — you can continue by text.",
        errorDetail: "Voice unavailable: {{detail}} — you can continue by text.",
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
        questionsScored: "{{count}} questions scored",
        moreQuestions: "{{count}} more questions",
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
        kicker: "Review",
        // Split so the count can carry the accent colour as a display headline.
        headlineLead: "You've answered",
        headlineAccent: "all {{count}} questions",
        yourAnswer: "Your answer",
        body: "Read them over. Nothing is scored until you submit, and your answers are shown exactly as they were recorded.",
        // The one irreversible action in the candidate's flow, so the consequence sits beside it.
        consequence: "Scoring takes about a minute. You can't change your answers afterwards.",
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
        maxFollowUps: "Max follow-ups",
        maxFollowUpsHint:
          "No longer used: since 2026-09-28 the judge only nudges (\"please go on\") during pauses and never asks follow-up questions in any turn mode; \"I'm done\" always moves to the next question. Kept for existing banks; the value has no effect.",
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
        users: {
          tab: "Users",
          hint: "One shared account per candidate seat — hand out the username and password below so a candidate can sign in and start their interview.",
          colUsername: "Username",
          colRole: "Role",
          colStatus: "Status",
          colPassword: "Password",
          statusActive: "Active",
          statusInactive: "Inactive",
          copy: "Copy",
          copied: "Copied",
          passwordStale: "Password needs reset (signing key rotated)",
          notViewable: "Not viewable",
          loading: "Loading users…",
          loadError: "Couldn't load users: {{message}}",
        },
      },
      // Candidate sign-in gate (#102) — shown on the interview page whenever no candidate JWT is
      // present. Candidates use the SAME /auth/login endpoint as admins, but a distinct token.
      candidate: {
        loginTitle: "Candidate sign-in",
        loginBody: "Sign in with the username and password your organizer gave you to start your interview.",
        // Reassurance under the sign-in headline. The candidate is about to be interviewed and
        // scored by a machine; saying the two things they actually worry about (no clock, their
        // choice of channel) before they log in is the point of the editorial column.
        loginReassurance:
          "Take your time. You can speak or type, and you decide when each answer is finished.",
        livePill: "LIVE",
        readyPill: "READY",
        yourInterviewer: "Your interviewer",
        // idle: the candidate is signed in and nothing has started. This screen CANNOT know the
        // question count — the interview does not exist until startInterview() — so it says what it
        // can honestly say and points forward for the count.
        idle: {
          kicker: "You're signed in",
          headlineLead: "Lisa is ready",
          headlineAccent: "when you are",
          lede: "She'll ask the questions out loud and listen to your answers. Nothing starts until you press the button.",
          fact1Title: "Speak or type",
          fact1Body: "Answer out loud, or switch to typing at any point in the interview. Both work the whole way through.",
          fact2Title: "You decide when an answer is finished",
          fact2Body: "Nothing is submitted until you say so, so a pause to think costs you nothing.",
          fact3Title: "No timer",
          fact3Body: "Take the time you need on every question. You can also start over from the beginning if you need to.",
          startNote: "You'll see how many questions there are on the next screen.",
        },
        // Shown as the portrait's caption on the pre-auth sign-in screen, where no persona is
        // loaded yet — it names the deployment's DEFAULT interviewer (DEFAULT_AVATAR_CHARACTER).
        defaultInterviewerName: "Lisa",
        wrongCredentials: "Incorrect username or password.",
        signOut: "Sign out",
        // "Start over" (v0.38.3.0): abandon the live interview and begin a fresh one. Destructive,
        // so it is confirmed in a dialog first.
        // Label deliberately avoids the substring "start interview": the e2e reload spec asserts
        // that no /start interview/i button remains once an interview is live.
        restart: "Start over",
        restartTitle: "Start over?",
        restartBody:
          "Your answers so far will be discarded and a new interview will start from the first question. This cannot be undone.",
        restartConfirm: "Yes, start over",
        restartCancel: "Keep going",
      },
    },
  },
  "zh-CN": {
    translation: {
      appTitle: "AI 面试",
      tagline: "可溯源 SOP、数字人面试",
      taglineLead: "可溯源 SOP、",
      taglineAccent: "数字人",
      taglineTail: "面试",
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
        // 外部模式没有固定题数(面试官逐题引导),沿用上面的题数文案会显示“0 道题”,故用此变体。
        bodyExternal: "面试官会逐题引导你完成对话。不用着急 —— 可以语音或打字作答，每题何时答完由你决定。",
        begin: "我准备好了",
        headlineLead: "{{total}} 道题,",
        headlineAccent: "按你的节奏",
        lede: "Lisa 会把每道题念出来。题目会一直留在屏幕上,方便你边想边重读。",
        railLabel: "面试概览",
        fact1Title: "怎么答都行",
        fact1Body: "说或打字,随时互相切换。",
        fact2Title: "答完了你说一声",
        fact2Body: "每个答案只在你说「答完了」之后才提交。",
        beginNote: "按下之后第 1 题立刻开始。",
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
        voiceOnlyNotice: "网络较弱 —— 已切换为语音模式",
        hideAvatar: "关闭画面",
        showAvatar: "开启画面",
        showAvatarCooldown: "稍后即可重新开启画面。",
        showAvatarCooldownSeconds: "约 {{seconds}} 秒后可重新开启画面。",
        endedFallback: "语音不可用 —— 你可以改用文字继续。",
        errorDetail: "语音不可用：{{detail}} —— 你可以改用文字继续。",
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
        questionsScored: "已评测 {{count}} 道题",
        moreQuestions: "还有 {{count}} 道题",
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
        kicker: "复核",
        headlineLead: "你已回答",
        headlineAccent: "全部 {{count}} 道题",
        yourAnswer: "你的回答",
        body: "请逐条读一遍。提交之前不会进行任何评测,你看到的就是系统记录下来的原文。",
        consequence: "评测大约需要一分钟。提交之后无法再修改答案。",
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
        maxFollowUps: "最多追问",
        maxFollowUpsHint: "已停用：自 2026-09-28 起，judge 在候选人停顿时只会轻声提示「请继续」，任何模式下都不再追问；点击「我答完了」一定进入下一题。字段为兼容旧题库保留，取值不再生效。",
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
        users: {
          tab: "用户",
          hint: "每个候选人席位对应一个共享账号 —— 将下方的用户名和密码提供给候选人,即可登录开始面试。",
          colUsername: "用户名",
          colRole: "角色",
          colStatus: "状态",
          colPassword: "密码",
          statusActive: "启用",
          statusInactive: "停用",
          copy: "复制",
          copied: "已复制",
          passwordStale: "密码需重置(签名密钥已轮换)",
          notViewable: "不可查看",
          loading: "正在加载用户…",
          loadError: "加载用户失败: {{message}}",
        },
      },
      // 候选人登录门(#102)——面试页在没有候选人 JWT 时展示。候选人使用与管理员相同的
      // /auth/login 接口,但持有独立的 token。
      candidate: {
        loginTitle: "候选人登录",
        loginReassurance: "不用着急。你可以说也可以打字,每一题什么时候算答完由你决定。",
        livePill: "在线",
        readyPill: "就绪",
        yourInterviewer: "你的面试官",
        idle: {
          kicker: "已登录",
          headlineLead: "Lisa 已就位,",
          headlineAccent: "等你开始",
          lede: "她会把问题念出来并听你回答。不按按钮就不会开始。",
          fact1Title: "说或打字都行",
          fact1Body: "你可以开口回答,也可以随时切换成打字。整场面试两种方式都一直可用。",
          fact2Title: "什么时候算答完由你决定",
          fact2Body: "你不说答完就不会提交,所以停下来想一想不会有任何代价。",
          fact3Title: "没有计时",
          fact3Body: "每道题你想花多久都可以。需要的话也可以从头重新开始。",
          startNote: "下一屏会告诉你一共有几道题。",
        },
        defaultInterviewerName: "Lisa",
        loginBody: "请使用主办方提供的用户名和密码登录,开始你的面试。",
        wrongCredentials: "用户名或密码错误。",
        signOut: "退出登录",
        // 「重新开始」(v0.38.3.0):放弃当前进行中的面试,从第一题重新开始。不可撤销,先弹窗确认。
        restart: "重新开始",
        restartTitle: "确定重新开始面试?",
        restartBody: "目前已作答的内容将被放弃,并从第一题开始一场新的面试。此操作无法撤销。",
        restartConfirm: "确定重新开始",
        restartCancel: "继续作答",
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
