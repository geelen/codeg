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

function codexView(
  parts: AdaptedContentPart[],
  isResponseComplete: boolean = true,
  durationMs: number = 388_386
) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer
        parts={parts}
        role="assistant"
        agentType="codex"
        durationMs={durationMs}
        isResponseComplete={isResponseComplete}
      />
    </NextIntlClientProvider>
  )
}

function renderCodex(parts: AdaptedContentPart[]) {
  return render(codexView(parts))
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
  it("renders completed work collapsed without Thought rows", async () => {
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
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("Ran 1 command")).not.toBeInTheDocument()
    expect(screen.queryByText("Private summary")).not.toBeInTheDocument()
    expect(screen.queryByText("Thought")).not.toBeInTheDocument()

    fireEvent.click(trigger)
    await waitFor(() => {
      expect(screen.getByText("Ran 1 command")).toBeInTheDocument()
    })
    expect(
      screen.getByText("The repository audit is complete.")
    ).toBeInTheDocument()
  })

  it("auto-collapses settled work and preserves a manual reopen", async () => {
    const liveParts: AdaptedContentPart[] = [
      {
        type: "text",
        text: "Checking the repositories.",
      },
      commandGroup(),
    ]
    const completedParts: AdaptedContentPart[] = [
      ...liveParts,
      {
        type: "text",
        text: "The repository audit is complete.",
      },
    ]
    const view = render(codexView(liveParts, false))

    expect(screen.getByRole("button", { name: "Working…" })).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(screen.getByText("Ran 1 command")).toBeInTheDocument()

    view.rerender(codexView(completedParts, true))
    const settledTrigger = screen.getByRole("button", {
      name: "Worked for 6m 28s",
    })
    expect(settledTrigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("Ran 1 command")).not.toBeInTheDocument()

    fireEvent.click(settledTrigger)
    await waitFor(() => {
      expect(screen.getByText("Ran 1 command")).toBeInTheDocument()
    })

    view.rerender(codexView(completedParts, true, 400_000))
    expect(
      screen.getByRole("button", { name: "Worked for 6m 40s" })
    ).toHaveAttribute("aria-expanded", "true")
  })
})
