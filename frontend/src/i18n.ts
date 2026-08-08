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
