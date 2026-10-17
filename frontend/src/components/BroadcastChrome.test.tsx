/** The broadcast layout's name plate and topic strip (owner, 2026-10-17). */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import i18n from "../i18n";
import { NamePlate, TopicStrip } from "./BroadcastChrome";

const wrap = (node: React.ReactNode) =>
  render(<FluentProvider theme={webLightTheme}>{node}</FluentProvider>);

describe("BroadcastChrome", () => {
  it("names the interviewer, and says she reads every question as written", async () => {
    await i18n.changeLanguage("en-US");
    wrap(<NamePlate name="Sakura" />);
    const plate = screen.getByTestId("stage-name-plate");
    expect(plate).toHaveTextContent("Sakura");
    expect(plate).toHaveTextContent("Your interviewer");
    expect(plate).toHaveTextContent("Reads every question exactly as written");
  });

  it("shows the interview's title, its question count and how answering works", async () => {
    await i18n.changeLanguage("en-US");
    wrap(<TopicStrip title="Clinical Study Manager" total={9} />);
    const strip = screen.getByTestId("stage-topic-strip");
    expect(screen.getByTestId("stage-topic-title")).toHaveTextContent("Clinical Study Manager");
    expect(strip).toHaveTextContent("9 questions");
    expect(strip).toHaveTextContent("Speak or type, switch anytime");
    expect(strip).toHaveTextContent("You decide when each answer is done");
    expect(strip).toHaveTextContent("At your pace");
  });

  it("with no fixed count (the interviewer drives) says guided; with no title, 'Interview'", async () => {
    await i18n.changeLanguage("en-US");
    wrap(<TopicStrip title={null} total={null} />);
    expect(screen.getByTestId("stage-topic-strip")).toHaveTextContent("Guided");
    expect(screen.getByTestId("stage-topic-title")).toHaveTextContent("Interview");
  });

  it("speaks Chinese too", async () => {
    await i18n.changeLanguage("zh-CN");
    wrap(<TopicStrip title="临床研究经理" total={1} />);
    expect(screen.getByTestId("stage-topic-strip")).toHaveTextContent("共 1 题");
    expect(screen.getByTestId("stage-topic-strip")).toHaveTextContent("按您的节奏");
    await i18n.changeLanguage("en-US");
  });
});
