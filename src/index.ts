import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import {
  createChatMessageHook,
  formatTerminalLog,
  resolveOptions,
  type RouterLogEntry,
  type RouterOptions,
} from "./router"

export * from "./router"

export function shouldShowNotification(entry: RouterLogEntry, diagnosticsEcho: boolean): boolean {
  return (
    diagnosticsEcho || entry.message === "judge selected tier" || entry.message === "judge failed; using fallback tier"
  )
}

const server: Plugin = async (input, rawOptions) => {
  const options = resolveOptions(rawOptions as RouterOptions | undefined)
  const runCommand = process.argv.includes("run")
  const logger = async (entry: RouterLogEntry) => {
    await input.client.app.log<true>({
      body: {
        service: "opencode-model-router",
        ...entry,
      },
    })
    if (!shouldShowNotification(entry, options.diagnostics.echo)) return

    const message = formatTerminalLog(entry)
    if (runCommand) {
      console.error(`[model-router] ${message}`)
      return
    }

    const variant = entry.level === "error" ? "error" : entry.level === "warn" ? "warning" : "info"
    await input.client.tui
      .showToast<true>({
        body: {
          title: "Model router",
          message,
          variant,
          duration: entry.level === "warn" || entry.level === "error" ? 5_000 : 2_500,
        },
      })
      .catch(() => undefined)
  }
  return { ...createChatMessageHook(options, globalThis.fetch, logger) }
}

const plugin: PluginModule = {
  id: "@sonarsource/opencode-model-router",
  server,
}

export default plugin
