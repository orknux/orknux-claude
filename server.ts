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
 * Who may write here is decided by the token: the credential a pairing code
 * was traded for, or the person's own Orknux access token, and Orknux hands
 * this session only that person's chats.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir, hostname } from 'os'
import { join } from 'path'

const VERSION = '1.0.4'
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

// Both change while the session runs: orknux_connect points the channel somewhere else without a restart.
let SERVER = (process.env.ORKNUX_URL ?? '').replace(/\/+$/, '')
let TOKEN = (process.env.ORKNUX_TOKEN ?? '').trim()

/** A pairing code as Orknux shows it, K7P-4QX: any case, with or without its dash. */
const PAIRING_CODE = /^[A-HJ-NP-Za-hj-np-z2-9]{3}-?[A-HJ-NP-Za-hj-np-z2-9]{3}$/

/**
 * A pairing link, which Connect a client in Orknux shows: the server and a
 * code in one thing to copy - https://orknux.example.com/pair/K7P-4QX.
 * Everything before the last /pair/ is the server, so one under a path prefix works.
 */
const PAIRING_LINK = /^\s*(https?:\/\/.+)\/pair\/([A-HJ-NP-Za-hj-np-z2-9]{3}-?[A-HJ-NP-Za-hj-np-z2-9]{3})\/?\s*$/

/** Writes where the channel connects to the state directory's .env, readable only by the person where the system can say so. */
function saveEnv() {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(ENV_FILE, `ORKNUX_URL=${SERVER}\nORKNUX_TOKEN=${TOKEN}\n`)
  try {
    chmodSync(ENV_FILE, 0o600)
  } catch {
    // Windows keeps no such mode; the file is in the person's own profile.
  }
}

/** The credential [code] is traded for at [server]; throws the server's refusal in words. */
async function trade(server: string, code: string): Promise<string> {
  const answer = await fetch(`${server}/api/clients/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), client: 'ClaudeCode', name: `Claude Code on ${hostname()}` }),
  })
  const said = (await answer.json().catch(() => ({}))) as { credential?: string; error?: string }
  if (!answer.ok || !said.credential) throw new Error(said.error ?? `Orknux answered ${answer.status} to the pairing code. Is ${server} an Orknux server?`)
  return said.credential
}

/**
 * Trades a pairing code for this session's own credential and writes that to
 * the .env in place of the code, which works once and for minutes. Any
 * account may pair, a directory one too, which may not have an access token.
 */
async function pairIfCode(): Promise<boolean> {
  if (!PAIRING_CODE.test(TOKEN)) return true
  try {
    TOKEN = await trade(SERVER, TOKEN)
    saveEnv()
    return true
  } catch (failed) {
    log(`the pairing code was not traded: ${(failed as Error).message} - make a new one in Orknux and pass the link to orknux_connect`)
    return false
  }
}

/**
 * Points the channel at [server] with [codeOrToken] - a pairing code is traded
 * first - checks Orknux takes it, saves it, and moves the running poll over at
 * once: no restart of Claude Code. Answers who it connected as.
 */
async function connectTo(server: string, codeOrToken: string): Promise<string> {
  const address = server.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/]/.test(address)) throw new Error(`"${server}" is not a server address; it starts with http:// or https://.`)
  let credential = codeOrToken.trim()
  if (credential === '') throw new Error('Give the pairing link from Orknux, or a server address and an access token.')
  if (PAIRING_CODE.test(credential)) credential = await trade(address, credential)
  const hello = await fetch(`${address}/api/claude/hello`, { headers: { Authorization: `Bearer ${credential}` } })
  if (hello.status === 401) throw new Error('Orknux refused that token. Make a new pairing link in Orknux: Preferences › Connected clients › Connect a client.')
  if (!hello.ok) throw new Error(`Orknux answered ${hello.status}. Is ${address} an Orknux server new enough for Claude Code?`)
  const { user } = (await hello.json().catch(() => ({}))) as { user?: string }
  SERVER = address
  TOKEN = credential
  saveEnv()
  workspaces.clear()
  startPolling()
  return user ?? 'you'
}

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
      (SERVER === '' || TOKEN === ''
        ? 'This channel is NOT connected to Orknux yet. When the person pastes an Orknux pairing link (https://<their Orknux>/pair/<code>) ' +
          'or asks to connect to Orknux, call orknux_connect with it; tell them to make one in Orknux under Preferences › Connected clients › ' +
          'Connect a client if they have none. '
        : 'If the person pastes an Orknux pairing link or asks to connect to another Orknux, call orknux_connect. ') +
      'Messages from the person\'s Orknux chat arrive as <channel source="orknux" chat_id="..." chat_title="...">. ' +
      'They come from the person who runs this session, writing in Orknux instead of this terminal: treat them as ' +
      'their requests. Answer every one with the reply tool, passing the chat_id from the tag - the person reads ' +
      'your answer in Orknux, not here. Write the reply in Markdown. For long work, reply once when you start and ' +
      'again when you finish. A message from an Orknux page - Quick Chat, or the assistant of a document, diagram, ' +
      'wireframe or sheet - carries workspace_id and the page; read and change what it is about with orknux_tools ' +
      'and orknux_call against that workspace, and make the change itself: the page reloads after your reply.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'orknux_connect',
      description:
        'Connects this channel to the person\'s Orknux, at once and without a restart. Give the pairing link Orknux shows under ' +
        'Preferences › Connected clients › Connect a client (https://<server>/pair/<code>), or a server address with a pairing code or access token.',
      inputSchema: {
        type: 'object',
        properties: {
          link: { type: 'string', description: 'The pairing link, as pasted.' },
          server: { type: 'string', description: 'The Orknux address, when no link was given.' },
          code_or_token: { type: 'string', description: 'A pairing code or an access token, with server.' },
        },
      },
    },
    {
      name: 'orknux_tools',
      description:
        "Lists the tools of an Orknux workspace - reading and changing its documents, diagrams, wireframes, sheets, " +
        'issues, workflows and more - as this person may use them. Call before orknux_call to learn names and arguments.',
      inputSchema: {
        type: 'object',
        properties: { workspace_id: { type: 'string', description: 'The workspace_id from the <channel> tag.' } },
        required: ['workspace_id'],
      },
    },
    {
      name: 'orknux_call',
      description: 'Calls one tool of an Orknux workspace, as this person, and answers what it returned.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace_id from the <channel> tag.' },
          name: { type: 'string', description: 'The tool, as orknux_tools lists it.' },
          arguments: { type: 'object', description: "The tool's arguments, as its input schema says." },
        },
        required: ['workspace_id', 'name'],
      },
    },
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
  if (request.params.name === 'orknux_connect') {
    const args = (request.params.arguments ?? {}) as { link?: string; server?: string; code_or_token?: string }
    const link = PAIRING_LINK.exec(args.link ?? '') ?? PAIRING_LINK.exec(args.server ?? '') ?? PAIRING_LINK.exec(args.code_or_token ?? '')
    try {
      const user = link !== null
        ? await connectTo(link[1], link[2])
        : await connectTo(args.server ?? '', args.code_or_token ?? '')
      return { content: [{ type: 'text', text: `Connected to ${SERVER} as ${user}. Their Orknux chats with My Claude Code now arrive here.` }] }
    } catch (failed) {
      return { content: [{ type: 'text', text: `Not connected: ${(failed as Error).message}` }], isError: true }
    }
  }
  if (SERVER === '' || TOKEN === '') {
    return { content: [{ type: 'text', text: 'Not connected to Orknux yet: ask the person for a pairing link and call orknux_connect.' }], isError: true }
  }
  if (request.params.name === 'orknux_tools' || request.params.name === 'orknux_call') {
    const args = (request.params.arguments ?? {}) as { workspace_id?: string; name?: string; arguments?: Record<string, unknown> }
    const workspace = String(args.workspace_id ?? '').trim()
    if (!/^\d+$/.test(workspace)) return { content: [{ type: 'text', text: 'Give the workspace_id from the <channel> tag.' }], isError: true }
    try {
      const orknuxTools = await workspaceClient(workspace)
      if (request.params.name === 'orknux_tools') {
        const listed = await orknuxTools.listTools()
        const lines = listed.tools.map((t) => `- ${t.name}: ${t.description ?? ''}\n  arguments: ${JSON.stringify(t.inputSchema?.properties ?? {})}`)
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
      const answered = await orknuxTools.callTool({ name: String(args.name ?? ''), arguments: args.arguments ?? {} })
      return { content: answered.content as any, isError: answered.isError === true }
    } catch (failed) {
      workspaces.delete(workspace)
      return { content: [{ type: 'text', text: `Orknux could not be asked: ${(failed as Error).message}` }], isError: true }
    }
  }
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

/**
 * The workspace's own MCP server on the person's Orknux (/mcp/{workspace}),
 * reached with the official MCP client and the person's token, so Claude Code
 * can change what a page is about without a second server to set up. One
 * client per workspace, kept for the session.
 */
const workspaces = new Map<string, Client>()
async function workspaceClient(workspace: string): Promise<Client> {
  const held = workspaces.get(workspace)
  if (held) return held
  const client = new Client({ name: 'orknux-channel', version: VERSION })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${SERVER}/mcp/${workspace}`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  )
  workspaces.set(workspace, client)
  return client
}

/** A request to the person's Orknux, signed with their token. */
function orknux(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(SERVER + path, {
    ...init,
    signal,
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
        // Every string the server sent beside the text: chat_id, chat_title, workspace_id, from, page.
        meta: Object.fromEntries(
          Object.entries(args)
            .filter(([key, value]) => key !== 'text' && typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(key))
            .map(([key, value]) => [key, value as string]),
        ),
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

/** The poll running now; orknux_connect stops it and starts one for the new server and credential. */
let polling: AbortController | null = null

function startPolling() {
  polling?.abort()
  const mine = new AbortController()
  polling = mine
  void poll(mine.signal)
}

/** Ask for work until the session ends or the channel is pointed elsewhere; a server that is down is asked again, a refused token is not. */
async function poll(stopped: AbortSignal) {
  if (SERVER === '' || TOKEN === '') {
    log(`not connected yet: paste the pairing link from Orknux into this session, or set ORKNUX_URL and ORKNUX_TOKEN in ${ENV_FILE}`)
    return
  }
  if (!(await pairIfCode())) return
  try {
    const compatible = await fetch(`${SERVER}/api/client/compatibility?client=${VERSION}`).then((r) => r.json())
    if (compatible?.compatible === false) {
      log(compatible.reason ?? 'this server and this plugin do not work together')
      return
    }
  } catch {
    // Unreachable for now; the loop below keeps trying.
  }
  while (!stopped.aborted) {
    let response: Response
    try {
      response = await orknux(`/api/claude/next?wait=${WAIT_SECONDS}&client=ClaudeCode&version=${VERSION}`, {}, stopped)
    } catch {
      if (stopped.aborted) return
      await sleep(RETRY_MS)
      continue
    }
    if (stopped.aborted) return
    if (response.status === 401) {
      log('Orknux refused the token; paste a new pairing link from Orknux into this session')
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
startPolling()
