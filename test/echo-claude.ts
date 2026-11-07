/**
 * A stand-in for Claude Code, for checking the whole path from an Orknux chat:
 * it starts the plugin over stdio as Claude Code does and answers every channel
 * event through the plugin's reply tool with "Echo: <message>". No model is
 * involved; this proves the plumbing, not Claude.
 *
 *   ORKNUX_URL=http://127.0.0.1:8080 ORKNUX_TOKEN=orkx_... bun test/echo-claude.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const client = new Client({ name: 'echo-claude', version: '0.0.0' })
client.fallbackNotificationHandler = async (n: any) => {
  if (n.method !== 'notifications/claude/channel') return
  const chat = n.params?.meta?.chat_id
  const text = `Echo: ${n.params?.content}`
  const answer = await client.callTool({ name: 'reply', arguments: { chat_id: chat, text } })
  console.log(`replied to chat ${chat}: ${text} -> ${JSON.stringify(answer.content)}`)
}
await client.connect(new StdioClientTransport({ command: 'bun', args: ['server.ts'], env: process.env as Record<string, string> }))
console.log('echo-claude connected')
await new Promise(() => {})
