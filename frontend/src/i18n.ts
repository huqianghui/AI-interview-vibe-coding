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
      },
      review: {
        title: "Review your answers",
        body: "You've answered every question. Read them over — when you're ready, submit to start SOP-based scoring.",
        action: "Submit & evaluate",
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
      },
      review: {
        title: "回顾你的回答",
        body: "你已回答完所有问题。请整体回顾一遍 —— 准备好后,点击提交即可开始按 SOP 评测。",
        action: "提交并评测",
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
