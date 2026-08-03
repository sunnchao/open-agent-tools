import assert from "node:assert/strict";
import test from "node:test";

import { PromptRenderError, renderPrompt } from "./prompt.js";

const prompt = {
  name: "summarize_report",
  title: "Summarize report",
  description: "Create a report summary request",
  arguments: [
    { name: "reportId", description: "Report identifier", required: true },
    { name: "style", description: "Summary style", required: false },
  ],
  messages: [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "Summarize {{reportId}} as {{style}}. Ref: {{reportId}}",
      },
    },
    {
      role: "assistant" as const,
      content: { type: "text" as const, text: "I will summarize {{reportId}}." },
    },
  ],
};

test("PRM-010 renders repeated placeholders in ordered messages", () => {
  const result = renderPrompt(prompt, { reportId: "report-1", style: "brief" });

  assert.deepEqual(result, {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Summarize report-1 as brief. Ref: report-1",
        },
      },
      {
        role: "assistant",
        content: { type: "text", text: "I will summarize report-1." },
      },
    ],
  });
});

test("PRM-008 rejects a missing required argument", () => {
  assert.throws(
    () => renderPrompt(prompt, { style: "brief" }),
    (error: unknown) =>
      error instanceof PromptRenderError &&
      error.code === "MISSING_REQUIRED_ARGUMENT" &&
      error.argumentName === "reportId",
  );
});

test("PRM-009 rejects undeclared arguments", () => {
  assert.throws(
    () => renderPrompt(prompt, { reportId: "report-1", unknown: "value" }),
    (error: unknown) =>
      error instanceof PromptRenderError &&
      error.code === "UNDECLARED_ARGUMENT" &&
      error.argumentName === "unknown",
  );
});

test("PRM-011 does not interpolate expressions introduced by argument values", () => {
  const result = renderPrompt(prompt, {
    reportId: "{{style}}",
    style: "brief",
  });

  assert.equal(result.messages[0]?.content.text, "Summarize {{style}} as brief. Ref: {{style}}");
});

test("PRM-015 rejects rendered output over the byte limit", () => {
  assert.throws(
    () =>
      renderPrompt(
        {
          ...prompt,
          messages: [
            {
              role: "user",
              content: { type: "text", text: "{{reportId}}" },
            },
          ],
        },
        { reportId: "123456" },
        { maxOutputBytes: 5 },
      ),
    (error: unknown) =>
      error instanceof PromptRenderError && error.code === "OUTPUT_LIMIT_EXCEEDED",
  );
});

test("PRM-016 preserves Unicode, newlines, quotes, and HTML-looking text", () => {
  const value = '测试\n"quoted" <script>alert(1)</script>';
  const result = renderPrompt(
    {
      ...prompt,
      messages: [
        {
          role: "user",
          content: { type: "text", text: "{{reportId}}" },
        },
      ],
    },
    { reportId: value },
  );

  assert.equal(result.messages[0]?.content.text, value);
});

test("optional omitted arguments render as empty text", () => {
  const result = renderPrompt(prompt, { reportId: "report-1" });

  assert.equal(result.messages[0]?.content.text, "Summarize report-1 as . Ref: report-1");
});
