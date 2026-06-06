/**
 * Hello World Plugin — Minimal Commander Plugin Example
 *
 * Demonstrates:
 *   - registerTool() — register a tool the LLM can call
 *   - on() — subscribe to lifecycle hooks
 *   - logger — use the structured logger
 *   - registerCommand() — register a CLI subcommand
 *
 * Install:
 *   commander plugin install ./examples/plugins/hello-world
 *
 * Usage:
 *   The LLM will see the "hello_world" tool and can call it.
 *   Or run: commander hello "World"
 */
const { createPlugin, defineTool, schema, stringProperty } = require('@commander/plugin-sdk');

module.exports = createPlugin({
  id: 'hello-world',
  name: 'Hello World Plugin',
  version: '1.0.0',
  description: 'A minimal example plugin',

  async register(api) {
    // ── Register a tool ──
    api.registerTool(defineTool({
      name: 'greet',
      description: 'Say hello to someone. Use this when the user wants a greeting.',
      inputSchema: schema({
        name: stringProperty('The name of the person to greet', { default: 'World' }),
        language: stringProperty('Language for the greeting', { enum: ['en', 'zh', 'es', 'ja'], default: 'en' }),
      }),
      async execute(args) {
        const name = args.name || 'World';
        const lang = args.language || 'en';

        const greetings = {
          en: `Hello, ${name}! Welcome to Commander! 🚀`,
          zh: `你好，${name}！欢迎使用 Commander！🚀`,
          es: `¡Hola, ${name}! ¡Bienvenido a Commander! 🚀`,
          ja: `こんにちは、${name}！Commanderへようこそ！🚀`,
        };

        const greeting = greetings[lang] || greetings.en;
        api.logger.info(`Greeted "${name}" in ${lang}`);
        return greeting;
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      category: 'general',
    }));

    // ── Subscribe to hooks ──
    api.on('onAgentStart', async (ctx) => {
      api.logger.info(`Agent started: ${ctx.ctx.agentId}`);
    });

    api.on('afterToolCall', async (ctx) => {
      if (ctx.toolName === 'hello-world__greet') {
        api.logger.debug(`Greeting delivered in ${ctx.result.durationMs}ms`);
      }
    });

    // ── Register a CLI command ──
    api.registerCommand('hello', {
      description: 'Say hello using the plugin',
      arguments: '[name]',
      action: async (name) => {
        const result = await api.runtime; // access runtime if needed
        console.log(`Hello, ${name || 'World'}! (from hello-world plugin)`);
      },
    });

    api.logger.info('Hello World plugin loaded successfully');
  },

  async unregister() {
    // Cleanup if needed
  },
});
