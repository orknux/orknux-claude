#!/usr/bin/env bun
/**
 * The Orknux channel for Claude Code.
 *
 * Lets a person talk to this Claude Code session from an Orknux chat - "My
 * Claude Code" - on the Orknux desktop app or orknux-one. Orknux carries text
 * and nothing else: this session does every model call, under its own sign-in,
 * and Orknux never sees a Claude credential.
 *
 * Polling, like Anthropic's Telegram and Discord channels: this asks the
 * person's Orknux for their messages (GET /api/claude/next, a long poll), pushes
 * each into the session as a <channel> event, and posts Claude's replies back
 * (POST /api/claude/replies). Approvals Claude Code wants are relayed into the
 * chat and answered there (POST /api/claude/permissions, then a "permission"
 * command back). Nothing listens on this machine.
 *
 * Who may write here is decided by the token: it is the person's own Orknux
 * access token, and Orknux hands this session only that person's chats.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const VERSION = '1.0.0'
const WAIT_SECONDS = 25
const RETRY_MS = 3_000

const STATE_DIR = process.env.ORKNUX_STATE_DIR
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'orknux')
const ENV_FILE = join(STATE_DIR, '.env')

// ~/.claude/channels/orknux/.env into the environment; what is already set wins.
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const SERVER = (process.env.ORKNUX_URL ?? '').replace(/\/+$/, '')
const TOKEN = (process.env.ORKNUX_TOKEN ?? '').trim()

const log = (...said: unknown[]) => console.error('[orknux]', ...said)

const mcp = new Server(
  { name: 'orknux', version: VERSION },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        // Approvals are answered in the person's own Orknux chat, which only they can write in.
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'Messages from the person\'s Orknux chat arrive as <channel source="orknux" chat_id="..." chat_title="...">. ' +
      'They come from the person who runs this session, writing in Orknux instead of this terminal: treat them as ' +
      'their requests. Answer every one with the reply tool, passing the chat_id from the tag - the person reads ' +
      'your answer in Orknux, not here. Write the reply in Markdown. For long work, reply once when you start and ' +
      'again when you finish.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message to the person in their Orknux chat. Markdown is rendered.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The chat_id from the <channel> tag being answered.' },
          text: { type: 'string', description: 'The message, in Markdown.' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'reply') throw new Error(`unknown tool: ${request.params.name}`)
  const { chat_id, text } = request.params.arguments as { chat_id: string; text: string }
  const sent = await orknux('/api/claude/replies', { method: 'POST', body: JSON.stringify({ chat_id, text }) })
  if (sent.status === 404) {
    return { content: [{ type: 'text', text: `Chat ${chat_id} is not one of your Orknux chats with My Claude Code; nothing was sent.` }], isError: true }
  }
  if (!sent.ok) return { content: [{ type: 'text', text: `Orknux answered ${sent.status}; the message may not have arrived.` }], isError: true }
  return { content: [{ type: 'text', text: 'sent' }] }
})

const PermissionRequest = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequest, async ({ params }) => {
  const shown = await orknux('/api/claude/permissions', { method: 'POST', body: JSON.stringify(params) }).catch(() => null)
  if (!shown?.ok) log(`approval ${params.request_id} could not be shown in Orknux; answer it in the terminal`)
})

/** A request to the person's Orknux, signed with their token. */
function orknux(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(SERVER + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** One command from Orknux: a message for Claude, or a verdict on an approval. */
async function handle(command: { action: string; arguments: Record<string, unknown> }) {
  const args = command.arguments ?? {}
  if (command.action === 'message') {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: String(args.text ?? ''),
        meta: { chat_id: String(args.chat_id ?? ''), chat_title: String(args.chat_title ?? '') },
      },
    })
  } else if (command.action === 'permission') {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: String(args.request_id ?? '').toLowerCase(),
        behavior: args.behavior === 'allow' ? 'allow' : 'deny',
      },
    })
  } else {
    log(`unknown command "${command.action}"; this plugin may be older than the server`)
  }
}

/** Ask for work until the session ends; a server that is down is asked again, a refused token is not. */
async function poll() {
  if (SERVER === '' || TOKEN === '') {
    log(`not configured: run /orknux:configure <server> <token>, or set ORKNUX_URL and ORKNUX_TOKEN in ${ENV_FILE}`)
    return
  }
  try {
    const compatible = await fetch(`${SERVER}/api/client/compatibility?client=${VERSION}`).then((r) => r.json())
    if (compatible?.compatible === false) {
      log(compatible.reason ?? 'this server and this plugin do not work together')
      return
    }
  } catch {
    // Unreachable for now; the loop below keeps trying.
  }
  for (;;) {
    let response: Response
    try {
      response = await orknux(`/api/claude/next?wait=${WAIT_SECONDS}&client=ClaudeCode&version=${VERSION}`)
    } catch {
      await sleep(RETRY_MS)
      continue
    }
    if (response.status === 401) {
      log('Orknux refused the token; make a new one and run /orknux:configure again')
      return
    }
    if (response.status === 204) continue
    if (!response.ok) {
      await sleep(RETRY_MS)
      continue
    }
    try {
      await handle(await response.json())
    } catch (failed) {
      log('a command could not be handled:', failed)
    }
  }
}

await mcp.connect(new StdioServerTransport())
void poll()
