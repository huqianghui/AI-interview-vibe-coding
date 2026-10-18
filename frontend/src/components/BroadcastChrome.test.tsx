/** The broadcast layout's name plate and topic strip (owner, 2026-10-17). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import i18n from "../i18n";
import {
  CropMarks,
  Masthead,
  NamePlate,
  SideNotes,
  StageBrief,
  TopicStrip,
} from "./BroadcastChrome";

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

  it("template B: the masthead says where the candidate is, in calm words", async () => {
    await i18n.changeLanguage("en-US");
    wrap(<Masthead index={1} total={9} language="English" voice="listening" />);
    const m = screen.getByTestId("stage-masthead");
    expect(m).toHaveTextContent("The interview");
    expect(m).toHaveTextContent("No. 01 / 09 · English · Listening");
  });

  it("template B: four crop marks; side notes only when there is room beside the window", async () => {
    await i18n.changeLanguage("en-US");
    wrap(
      <>
        <CropMarks />
        <SideNotes gutter={140} index={1} total={9} voice="ready" />
      </>,
    );
    expect(screen.getAllByTestId("stage-crop-mark")).toHaveLength(4);
    expect(screen.queryByTestId("stage-side-voice")).toBeNull(); // 140 px cannot hold a note
  });

  it("template B: the side notes follow the question and the voice's state", async () => {
    await i18n.changeLanguage("en-US");
    wrap(<SideNotes gutter={260} index={3} total={9} voice="muted" />);
    expect(screen.getByTestId("stage-side-question")).toHaveTextContent("03");
    expect(screen.getByTestId("stage-side-question")).toHaveTextContent("of 9. One at a time, no rush.");
    expect(screen.getByTestId("stage-side-voice")).toHaveTextContent(
      "Your microphone is off. Unmute when you are ready.",
    );
  });

  describe("template B: the brief under the strip", () => {
    afterEach(() => vi.unstubAllGlobals());
    const withRoom = (height: number) => {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(private cb: () => void) {}
          observe() {
            this.cb();
          }
          disconnect() {}
        },
      );
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get: () => height,
      });
    };
    afterEach(() => {
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    });

    it("on a tall stage: the three tips and the closing line", async () => {
      await i18n.changeLanguage("en-US");
      withRoom(300);
      wrap(<StageBrief />);
      expect(screen.getByTestId("stage-tips")).toHaveTextContent("Think first");
      expect(screen.getByTestId("stage-tips")).toHaveTextContent("Finish on your terms");
      expect(screen.getByTestId("stage-quote")).toHaveTextContent("A good answer often starts with a pause.");
    });

    it("with less room: the tips only; with none: nothing (fewer words, never clipped ones)", async () => {
      await i18n.changeLanguage("en-US");
      withRoom(180);
      const { unmount } = wrap(<StageBrief />);
      expect(screen.getByTestId("stage-tips")).toBeInTheDocument();
      expect(screen.queryByTestId("stage-quote")).toBeNull();
      unmount();
      withRoom(60);
      wrap(<StageBrief />);
      expect(screen.queryByTestId("stage-tips")).toBeNull();
    });
  });
});
