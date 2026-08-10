import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createChatMessageHook, resolveOptions, type RouterLogEntry, type RouterOptions } from "./router"

export * from "./router"

const server: Plugin = async (input, rawOptions) => {
  const options = resolveOptions(rawOptions as RouterOptions | undefined)
  const logger = async (entry: RouterLogEntry) => {
    if (options.diagnostics.echo) {
      console.error(`[opencode-model-router] ${JSON.stringify(entry)}`)
    }
    await input.client.app.log<true>({
      body: {
        service: "opencode-model-router",
        ...entry,
      },
    })
  }
  return { "chat.message": createChatMessageHook(options, globalThis.fetch, logger) }
}

const plugin: PluginModule = {
  id: "@sonarsource/opencode-model-router",
  server,
}

export default plugin
