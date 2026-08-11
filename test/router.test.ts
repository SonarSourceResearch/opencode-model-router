import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import plugin, { shouldShowNotification } from "../src/index"
import {
  DEFAULT_TIERS,
  DEFAULT_JUDGE_MAX_OUTPUT_TOKENS,
  MAX_TASK_CHARACTERS,
  buildJudgePrompt,
  buildJudgeSchema,
  createChatMessageHook,
  formatTerminalLog,
  humanText,
  resolveOptions,
  type ModelTarget,
  type RouterLogEntry,
} from "../src/router"

type Hook = NonNullable<Hooks["chat.message"]>
type Input = Parameters<Hook>[0]
type Output = Parameters<Hook>[1]

function input(model = { providerID: "model-router", modelID: "auto" }): Input {
  return { sessionID: "session", model }
}

function output(text = "Fix the typo"): Output {
  return {
    message: {
      id: "message",
      sessionID: "session",
      role: "user",
      time: { created: 0 },
      agent: "plan",
      model: { providerID: "model-router", modelID: "auto" },
    },
    parts: [
      {
        id: "part",
        sessionID: "session",
        messageID: "message",
        type: "text",
        text,
      },
    ],
  }
}

function judgeResponse(tier: string): Response {
  return Response.json({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ tier }) }] }] })
}

function reasoningJudgeResponse(tier: string): Response {
  return Response.json({
    output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "The task appears easy." }] },
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify({ tier }) }],
      },
    ],
  })
}

function routedModel(value: Output): ModelTarget {
  return value.message.model as ModelTarget
}

describe("judge prompt", () => {
  test("exports an explicit OpenCode server plugin module", () => {
    expect(plugin.id).toBe("@sonarsource/opencode-model-router")
    expect(typeof plugin.server).toBe("function")
  })

  test("describes default tiers and produces a strict enum schema", () => {
    expect(buildJudgePrompt(DEFAULT_TIERS)).toContain("- easy: Routine, well-scoped work")
    expect(buildJudgePrompt(DEFAULT_TIERS)).toContain('{"tier":"easy"|"complex"}')
    expect(buildJudgeSchema(DEFAULT_TIERS)).toEqual({
      type: "object",
      properties: { tier: { type: "string", enum: ["easy", "complex"] } },
      required: ["tier"],
      additionalProperties: false,
    })
  })

  test("adds a third tier from configuration only", () => {
    const tiers = [
      ...DEFAULT_TIERS,
      { id: "critical", description: "Irreversible production work.", target: { providerID: "p", modelID: "m" } },
    ]
    expect(buildJudgePrompt(tiers)).toContain("- critical: Irreversible production work.")
    expect(buildJudgeSchema(tiers)).toMatchObject({ properties: { tier: { enum: ["easy", "complex", "critical"] } } })
  })
})

describe("validation", () => {
  test("rejects invalid tier ids, duplicate ids, targets, and fallbacks", () => {
    expect(() => resolveOptions({ tiers: [] })).toThrow("at least one")
    expect(() =>
      resolveOptions({ tiers: [{ id: "Not Valid", description: "x", target: { providerID: "p", modelID: "m" } }] }),
    ).toThrow("must match")
    expect(() => resolveOptions({ tiers: [DEFAULT_TIERS[0]!, DEFAULT_TIERS[0]!] })).toThrow("duplicated")
    expect(() =>
      resolveOptions({ tiers: [{ id: "easy", description: "x", target: { providerID: "", modelID: "m" } }] }),
    ).toThrow("providerID")
    expect(() => resolveOptions({ fallbackTier: "missing" })).toThrow("does not identify")
  })

  test("rejects an invalid trigger and timeout", () => {
    expect(() => resolveOptions({ trigger: { providerID: "router", modelID: "" } })).toThrow("trigger.modelID")
    expect(() => resolveOptions({ judge: { timeoutMs: 0 } })).toThrow("positive finite")
    expect(() => resolveOptions({ diagnostics: { echo: "yes" as unknown as boolean } })).toThrow(
      "diagnostics.echo must be a boolean",
    )
  })

  test("terminal diagnostics are opt-in", () => {
    expect(resolveOptions().diagnostics.echo).toBeFalse()
    expect(resolveOptions({ diagnostics: { echo: true } }).diagnostics.echo).toBeTrue()
  })

  test("stays on automatic routing by default", () => {
    expect(resolveOptions().stayOnAuto).toBeTrue()
    expect(resolveOptions({ stayOnAuto: false }).stayOnAuto).toBeFalse()
  })
})

describe("routing", () => {
  test("always shows route decisions", () => {
    expect(shouldShowNotification({ level: "info", message: "judge selected tier" }, false)).toBeTrue()
    expect(shouldShowNotification({ level: "warn", message: "judge failed; using fallback tier" }, false)).toBeTrue()
    expect(shouldShowNotification({ level: "info", message: "judge request" }, false)).toBeFalse()
    expect(shouldShowNotification({ level: "info", message: "judge request" }, true)).toBeTrue()
  })

  test("formats concise terminal diagnostics", () => {
    expect(
      formatTerminalLog({
        level: "info",
        message: "judge request",
        extra: { body: { model: "Qwen3.6-Sonar", input: "hello" } },
      }),
    ).toBe("Judge request → Qwen3.6-Sonar · 5 chars")
    expect(
      formatTerminalLog({
        level: "info",
        message: "judge response",
        extra: {
          status: 200,
          body: { output: [{ content: [{ type: "output_text", text: '{"tier":"easy"}' }] }] },
        },
      }),
    ).toBe('Judge response ← HTTP 200 · {"tier":"easy"}')
    expect(
      formatTerminalLog({
        level: "info",
        message: "judge selected tier",
        extra: { tier: "complex", target: { providerID: "portkey", modelID: "gpt-5.6-sol", variant: "high" } },
      }),
    ).toBe("Route selected: complex → portkey/gpt-5.6-sol/high")
  })

  test("routes to the tier returned by one Responses API call", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const logs: RouterLogEntry[] = []
    const fetchImpl = async (request: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(request), body: JSON.parse(String(init?.body)) })
      return judgeResponse("easy")
    }
    const routed = output()
    const hooks = createChatMessageHook(resolveOptions(), fetchImpl, async (entry) => {
      logs.push(entry)
    })
    await hooks["chat.message"](input(), routed)

    expect(routedModel(routed)).toEqual({ providerID: "sonarllm-dogfooding", modelID: "Qwen3.6-Sonar", variant: undefined })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toEndWith("/responses")
    expect(calls[0]?.body).toMatchObject({
      model: "Qwen3.6-Sonar",
      max_output_tokens: DEFAULT_JUDGE_MAX_OUTPUT_TOKENS,
      text: { format: { type: "json_schema", strict: true } },
    })
    expect(logs.map((entry) => entry.message)).toEqual([
      "judge request",
      "judge response",
      "judge selected tier",
    ])
    expect(logs[0]?.extra).toMatchObject({
      sessionID: "session",
      body: { model: "Qwen3.6-Sonar", max_output_tokens: DEFAULT_JUDGE_MAX_OUTPUT_TOKENS },
    })
    expect(logs[1]?.extra).toMatchObject({ status: 200, body: { output: expect.any(Array) } })
  })

  test("routes a dynamic third tier", async () => {
    const options = resolveOptions({
      tiers: [
        ...DEFAULT_TIERS,
        { id: "critical", description: "Critical", target: { providerID: "special", modelID: "best", variant: "max" } },
      ],
    })
    const routed = output()
    const hooks = createChatMessageHook(options, async () => judgeResponse("critical"))
    await hooks["chat.message"](input(), routed)
    expect(routedModel(routed)).toEqual({ providerID: "special", modelID: "best", variant: "max" })
  })

  test("ignores reasoning text before the structured output", async () => {
    const routed = output("What is 2 + 2?")
    const hooks = createChatMessageHook(resolveOptions(), async () => reasoningJudgeResponse("easy"))
    await hooks["chat.message"](input(), routed)
    expect(routedModel(routed)).toEqual({ providerID: "sonarllm-dogfooding", modelID: "Qwen3.6-Sonar", variant: undefined })
  })

  test("manual model selection bypasses routing", async () => {
    let called = false
    const routed = output()
    const hooks = createChatMessageHook(resolveOptions(), async () => {
      called = true
      return judgeResponse("easy")
    })
    await hooks["chat.message"](input({ providerID: "sonarllm-dogfooding", modelID: "Qwen3.6-Sonar" }), routed)
    expect(called).toBeFalse()
    expect(routed.message.model.providerID).toBe("model-router")
  })

  test("routes session continuations using the persisted message model", async () => {
    const routed = output()
    const hooks = createChatMessageHook(resolveOptions(), async () => judgeResponse("complex"))
    await hooks["chat.message"]({ sessionID: "session" }, routed)
    expect(routedModel(routed)).toEqual({ providerID: "portkey", modelID: "gpt-5.6-sol", variant: "high" })
  })

  test("judge errors and invalid output fall back to complex", async () => {
    for (const fetchImpl of [
      async () => {
        throw new Error("offline")
      },
      async () => judgeResponse("unknown"),
    ]) {
      const routed = output()
      const hooks = createChatMessageHook(resolveOptions(), fetchImpl)
      await hooks["chat.message"](input(), routed)
      expect(routedModel(routed)).toEqual({ providerID: "portkey", modelID: "gpt-5.6-sol", variant: "high" })
    }
  })

  test("logs the error and fallback target when judging fails", async () => {
    const logs: RouterLogEntry[] = []
    const routed = output()
    const hooks = createChatMessageHook(
      resolveOptions(),
      async () => {
        throw new Error("offline")
      },
      async (entry) => {
        logs.push(entry)
      },
    )
    await hooks["chat.message"](input(), routed)

    expect(logs.at(-1)).toMatchObject({
      level: "warn",
      message: "judge failed; using fallback tier",
      extra: {
        error: "Error: offline",
        tier: "complex",
        target: { providerID: "portkey", modelID: "gpt-5.6-sol", variant: "high" },
      },
    })
  })

  test("sends only non-synthetic user text, capped at 4,000 characters", () => {
    const routed = output("a".repeat(MAX_TASK_CHARACTERS + 500))
    routed.parts.push({
      id: "synthetic",
      sessionID: "session",
      messageID: "message",
      type: "text",
      text: "secret",
      synthetic: true,
    })
    expect(humanText(routed)).toHaveLength(MAX_TASK_CHARACTERS)
    expect(humanText(routed)).not.toContain("secret")
  })

  test("switches to target model when stayOnAuto is false", async () => {
    const routed = output()
    const hooks = createChatMessageHook(resolveOptions({ stayOnAuto: false }), async () => judgeResponse("easy"))
    await hooks["chat.message"](input(), routed)
    expect(routedModel(routed)).toEqual({ providerID: "sonarllm-dogfooding", modelID: "Qwen3.6-Sonar", variant: undefined })
  })

  test("routes the current message when stayOnAuto is true", async () => {
    const routed = output()
    const hooks = createChatMessageHook(resolveOptions({ stayOnAuto: true }), async () => judgeResponse("easy"))
    await hooks["chat.message"](input(), routed)
    expect(routedModel(routed)).toEqual({ providerID: "sonarllm-dogfooding", modelID: "Qwen3.6-Sonar", variant: undefined })
  })

})
