/** Language toggle — persists choice to localStorage (read back by i18n.ts on next load). */
import { useTranslation } from "react-i18next";
import { Dropdown, Option } from "@fluentui/react-components";
import { SUPPORTED_LANGUAGES } from "../i18n";

const LABELS: Record<string, string> = { "zh-CN": "中文", "en-US": "English" };

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();

  function onSelect(lang: string) {
    void i18n.changeLanguage(lang);
    if (typeof localStorage !== "undefined") localStorage.setItem("lang", lang);
  }

  return (
    <Dropdown
      aria-label={t("language")}
      value={LABELS[i18n.language] ?? i18n.language}
      selectedOptions={[i18n.language]}
      onOptionSelect={(_, d) => d.optionValue && onSelect(d.optionValue)}
    >
      {SUPPORTED_LANGUAGES.map((lang) => (
        <Option key={lang} value={lang}>
          {LABELS[lang]}
        </Option>
      ))}
    </Dropdown>
  );
}
