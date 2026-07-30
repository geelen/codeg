import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import {
  ContentPartsRenderer,
  splitCodexActivityParts,
} from "./content-parts-renderer"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import enMessages from "@/i18n/messages/en.json"

function commandGroup(): AdaptedContentPart {
  return {
    type: "tool-group",
    isStreaming: false,
    items: [
      {
        type: "tool-call",
        toolCallId: "cmd-1",
        toolName: "bash",
        input: JSON.stringify({ command: "git status --short" }),
        state: "output-available",
        output: "",
      },
    ],
  }
}

function renderCodex(parts: AdaptedContentPart[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer
        parts={parts}
        role="assistant"
        agentType="codex"
        durationMs={388_386}
        isResponseComplete
      />
    </NextIntlClientProvider>
  )
}

describe("splitCodexActivityParts", () => {
  it("drops reasoning, groups work, and leaves the final answer visible", () => {
    const activityText: AdaptedContentPart = {
      type: "text",
      text: "Checking the repositories.",
    }
    const reasoning: AdaptedContentPart = {
      type: "reasoning",
      content: "Private summary",
      isStreaming: false,
    }
    const answer: AdaptedContentPart = {
      type: "text",
      text: "The repository audit is complete.",
    }

    expect(
      splitCodexActivityParts(
        [activityText, commandGroup(), reasoning, answer],
        true
      )
    ).toEqual({
      activity: [activityText, commandGroup()],
      answer: [answer],
    })
  })

  it("keeps a plain one-block reply out of activity chrome", () => {
    const answer: AdaptedContentPart = {
      type: "text",
      text: "Nothing to do.",
    }
    expect(splitCodexActivityParts([answer], true)).toEqual({
      activity: [],
      answer: [answer],
    })
  })

  it("keeps an unfinished response inside the live work section", () => {
    const commentary: AdaptedContentPart = {
      type: "text",
      text: "Still checking.",
    }
    expect(
      splitCodexActivityParts(
        [
          {
            type: "reasoning",
            content: "Private summary",
            isStreaming: true,
          },
          commentary,
        ],
        false
      )
    ).toEqual({
      activity: [commentary],
      answer: [],
    })
  })
})

describe("ContentPartsRenderer Codex activity", () => {
  it("renders compact collapsible work without Thought rows", async () => {
    renderCodex([
      {
        type: "text",
        text: "Checking the repositories.",
      },
      {
        type: "reasoning",
        content: "Private summary",
        isStreaming: false,
      },
      commandGroup(),
      {
        type: "text",
        text: "The repository audit is complete.",
      },
    ])

    const trigger = screen.getByRole("button", {
      name: "Worked for 6m 28s",
    })
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Ran 1 command")).toBeInTheDocument()
    expect(screen.queryByText("Private summary")).not.toBeInTheDocument()
    expect(screen.queryByText("Thought")).not.toBeInTheDocument()

    fireEvent.click(trigger)
    await waitFor(() => {
      expect(
        screen.queryByText("Checking the repositories.")
      ).not.toBeInTheDocument()
    })
    expect(
      screen.getByText("The repository audit is complete.")
    ).toBeInTheDocument()
  })
})
