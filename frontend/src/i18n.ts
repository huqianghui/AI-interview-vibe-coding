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
        endedFallback: "Voice unavailable — you can continue by text.",
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
        endedFallback: "语音不可用 —— 你可以改用文字继续。",
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
    },
  },
} as const;

export const SUPPORTED_LANGUAGES = ["zh-CN", "en-US"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const stored =
  typeof localStorage !== "undefined" ? localStorage.getItem("lang") : null;

void i18n.use(initReactI18next).init({
  resources,
  lng: stored ?? "zh-CN",
  fallbackLng: "en-US",
  interpolation: { escapeValue: false },
});

export default i18n;
