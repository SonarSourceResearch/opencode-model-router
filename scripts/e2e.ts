import { mkdir, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const MINIMUM_OPENCODE = [1, 18, 16] as const
const COMMAND_TIMEOUT_MS = 6 * 60_000
const projectRoot = resolve(import.meta.dir, "..")

function debug(...args: unknown[]) {
  console.log("[DEBUG]", ...args)
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type ExportData = {
  messages: Array<{
    info: {
      id: string
      role: "user" | "assistant"
      parentID?: string
      model?: { providerID: string; modelID: string; variant?: string }
      providerID?: string
      modelID?: string
      variant?: string
    }
    parts: Array<{ type: string; text?: string; state?: { status?: string } }>
  }>
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function command(args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<CommandResult> {
  const process = Bun.spawn(args, {
    cwd: projectRoot,
    env: { ...Bun.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => process.kill(), options.timeoutMs ?? COMMAND_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timeout)
  }
}

function atLeast(actual: string, minimum: readonly number[]): boolean {
  const parsed = actual.trim().replace(/^v/, "").split(".").map(Number)
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (parsed[index] ?? 0) - (minimum[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

function isolatedEnvironment(root: string, config: string): Record<string, string> {
  return {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg", "config"),
    XDG_DATA_HOME: join(root, "xdg", "data"),
    XDG_STATE_HOME: join(root, "xdg", "state"),
    XDG_CACHE_HOME: join(root, "xdg", "cache"),
    OPENCODE_CONFIG: config,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  }
}

function config(pluginURL: string, judgeBaseURL: string, dogfoodingBaseURL: string, stayOnAuto = true): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    plugin: [[pluginURL, { judge: { baseURL: judgeBaseURL }, diagnostics: { echo: true }, stayOnAuto }]],
    provider: {
      "model-router": {
        npm: "@ai-sdk/openai-compatible",
        name: "Tiered model router trigger",
        options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "unused" },
        models: { auto: { name: "Automatic tier" } },
      },
      "sonarllm-dogfooding": {
        npm: "@ai-sdk/openai-compatible",
        name: "SonarLLM Dogfooding",
        options: { baseURL: dogfoodingBaseURL },
        models: {
          "Qwen3.6-Sonar": {
            name: "Qwen3.6-Sonar",
            limit: { context: 260_000, output: 8_192 },
          },
        },
      },
      portkey: {
        npm: "@ai-sdk/openai",
        name: "Portkey",
        options: {
          baseURL: "https://api.portkey.ai/v1",
          apiKey: "{env:PORTKEY_OPENAI_API_KEY}",
        },
        models: {
          "gpt-5.6-sol": {
            name: "gpt-5.6-sol",
            reasoning: true,
            variants: { high: { reasoningEffort: "high" } },
          },
        },
      },
    },
  }
}

function sessionID(result: CommandResult): string {
  const match = `${result.stdout}\n${result.stderr}`.match(/ses_[A-Za-z0-9]+/)
  invariant(match, "OpenCode output did not include a session ID")
  return match[0]
}

function users(data: ExportData) {
  return data.messages.filter((message) => message.info.role === "user")
}

function assistantFor(data: ExportData, userID: string) {
  return data.messages.find((message) => message.info.role === "assistant" && message.info.parentID === userID)
}

function assertTurn(data: ExportData, index: number, target: { providerID: string; modelID: string; variant?: string }, tool: boolean) {
  const user = users(data)[index]
  invariant(user, `missing user turn ${index + 1}`)
  invariant(user.info.model?.providerID === target.providerID, `turn ${index + 1}: expected provider ${target.providerID}`)
  invariant(user.info.model.modelID === target.modelID, `turn ${index + 1}: expected model ${target.modelID}`)
  invariant(user.info.model.variant === target.variant, `turn ${index + 1}: expected variant ${target.variant ?? "none"}`)

  const assistant = assistantFor(data, user.info.id)
  invariant(assistant, `turn ${index + 1}: missing assistant response`)
  invariant(assistant.info.providerID === target.providerID, `turn ${index + 1}: assistant provider was not recorded`)
  invariant(assistant.info.modelID === target.modelID, `turn ${index + 1}: assistant model was not recorded`)
  invariant(assistant.info.variant === target.variant, `turn ${index + 1}: assistant variant was not recorded`)
  invariant(assistant.parts.some((part) => part.type === "text" && Boolean(part.text)), `turn ${index + 1}: missing final answer`)
  if (tool) {
    invariant(
      assistant.parts.some((part) => part.type === "tool" && part.state?.status === "completed"),
      `turn ${index + 1}: expected a completed tool invocation`,
    )
  }
}

async function main() {
  invariant(Bun.env.RUN_LIVE_E2E === "1", "Live E2E is disabled. Run with RUN_LIVE_E2E=1 bun run e2e")
  invariant(Bun.env.PORTKEY_OPENAI_API_KEY, "PORTKEY_OPENAI_API_KEY is required")

  const version = await command(["opencode", "--version"], { timeoutMs: 10_000 })
  invariant(version.exitCode === 0, `could not run OpenCode: ${version.stderr}`)
  invariant(atLeast(version.stdout, MINIMUM_OPENCODE), `OpenCode ${MINIMUM_OPENCODE.join(".")} or newer is required`)

  const dogfoodingBaseURL = (
    Bun.env.SONARLLM_DOGFOODING_BASE_URL ?? "https://sonarllm-dogfooding.aws-dev.sonarsource.com/v1"
  ).replace(/\/+$/, "")
  const stamp = new Date().toISOString().replaceAll(":", "-")
  const artifacts = join(projectRoot, "artifacts", `e2e-${stamp}`)
  const pluginURL = pathToFileURL(await realpath(join(projectRoot, "src", "index.ts"))).href
  const results: Record<string, { status: "passed" | "failed"; error?: string }> = {}
  await mkdir(artifacts, { recursive: true })

  async function scenario(name: string, test: () => Promise<void>) {
    debug("Starting scenario:", name)
    try {
      await test()
      results[name] = { status: "passed" }
      console.log(`${name}: passed`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results[name] = { status: "failed", error: message }
      console.error(`${name}: failed: ${message}`)
      debug("Scenario failed:", name, error)
    }
  }

  async function setup(name: string, judgeBaseURL = dogfoodingBaseURL, stayOnAuto = true) {
    const root = join(artifacts, name)
    const configPath = join(root, "opencode.json")
    const opencodeConfigRoot = join(root, "xdg", "config", "opencode")
    debug("Setting up scenario:", name, "root:", root)
    debug("Judge base URL:", judgeBaseURL)
    debug("stayOnAuto:", stayOnAuto)
    await mkdir(join(root, "home"), { recursive: true })
    await mkdir(join(opencodeConfigRoot, "node_modules"), { recursive: true })
    await Bun.write(
      join(opencodeConfigRoot, "package-lock.json"),
      `${JSON.stringify({ packages: { "": { dependencies: { "@opencode-ai/plugin": "1.18.16" } } } }, null, 2)}\n`,
    )
    await Bun.write(configPath, `${JSON.stringify(config(pluginURL, judgeBaseURL, dogfoodingBaseURL, stayOnAuto), null, 2)}\n`)
    debug("Config written to:", configPath)
    return { root, configPath, env: isolatedEnvironment(root, configPath) }
  }

  async function run(name: string, env: Record<string, string>, args: string[]) {
    const cmd = ["opencode", "run", "--format", "json", "--agent", "plan", ...args]
    debug("Running command:", name, cmd.join(" "))
    const result = await command(cmd, { env })
    await Bun.write(join(artifacts, `${name}.stdout.jsonl`), result.stdout)
    await Bun.write(join(artifacts, `${name}.stderr.log`), result.stderr)
    debug("Command exit code:", result.exitCode, "stdout length:", result.stdout.length, "stderr length:", result.stderr.length)
    invariant(result.exitCode === 0, `${name} failed (see ${artifacts})`)
    return result
  }

  async function exported(name: string, env: Record<string, string>, id: string): Promise<ExportData> {
    const result = await command(["opencode", "export", id, "--sanitize"], { env, timeoutMs: 30_000 })
    await Bun.write(join(artifacts, `${name}.export.json`), result.stdout)
    await Bun.write(join(artifacts, `${name}.export.stderr.log`), result.stderr)
    invariant(result.exitCode === 0, `${name} export failed (see ${artifacts})`)
    return JSON.parse(result.stdout) as ExportData
  }

  const normal = await setup("normal")
  let easySession: string | undefined
  await scenario("easy", async () => {
    const easyRun = await run("01-easy", normal.env, ["--model", "model-router/auto", "Reply with a brief greeting."])
    easySession = sessionID(easyRun)
    const easyExport = await exported("01-easy", normal.env, easySession)
    assertTurn(easyExport, 0, { providerID: "sonarllm-dogfooding", modelID: "Qwen3.6-Sonar" }, false)
  })

  const complexPrompt =
    "Investigate fixtures/e2e/router-fixture.ts using a read-only tool. Explain how its exported function and marker could support a multi-file routing test; do not edit files."
  await scenario("complexAutomaticContinuation", async () => {
    const complexRun = await run("02-complex", normal.env, ["--model", "model-router/auto", complexPrompt])
    const complexExport = await exported("02-complex", normal.env, sessionID(complexRun))
    assertTurn(complexExport, 0, { providerID: "portkey", modelID: "gpt-5.6-sol", variant: "high" }, true)
  })

  await scenario("sessionRejudge", async () => {
    invariant(easySession, "easy scenario did not create a session")
    await run("03-continuation", normal.env, ["--session", easySession, complexPrompt])
    const continuedExport = await exported("03-continuation", normal.env, easySession)
    assertTurn(continuedExport, 1, { providerID: "portkey", modelID: "gpt-5.6-sol", variant: "high" }, true)
    assertTurn(continuedExport, 0, { providerID: "sonarllm-dogfooding", modelID: "Qwen3.6-Sonar" }, false)
  })

  const fallback = await setup("fallback", "http://127.0.0.1:1/v1")
  await scenario("judgeFailureFallback", async () => {
    const fallbackRun = await run("04-fallback", fallback.env, ["--model", "model-router/auto", "Reply with one sentence."])
    const fallbackExport = await exported("04-fallback", fallback.env, sessionID(fallbackRun))
    assertTurn(fallbackExport, 0, { providerID: "portkey", modelID: "gpt-5.6-sol", variant: "high" }, false)
  })

  const stayOnAutoConfig = await setup("stayOnAuto", dogfoodingBaseURL, true)
  await scenario("autoMode", async () => {
    const autoRun = await run("05-auto-stayon", stayOnAutoConfig.env, ["--model", "model-router/auto", "Write a simple 'Hello, World!' program in Python."])
    const autoSession = sessionID(autoRun)
    await run("06-auto-continuation", stayOnAutoConfig.env, ["--session", autoSession, complexPrompt])
    const autoExport = await exported("06-auto-continuation", stayOnAutoConfig.env, autoSession)
    assertTurn(autoExport, 0, { providerID: "sonarllm-dogfooding", modelID: "Qwen3.6-Sonar" }, false)
    assertTurn(autoExport, 1, { providerID: "portkey", modelID: "gpt-5.6-sol", variant: "high" }, true)
  })

  await Bun.write(
    join(artifacts, "results.json"),
    `${JSON.stringify(
      {
        opencodeVersion: version.stdout.trim(),
        scenarios: results,
      },
      null,
      2,
    )}\n`,
  )
  const failed = Object.entries(results).filter(([, result]) => result.status === "failed")
  invariant(failed.length === 0, `live E2E failed: ${failed.map(([name]) => name).join(", ")} (see ${artifacts})`)
  console.log(`Live E2E passed. Artifacts: ${artifacts}`)
}

await main()
