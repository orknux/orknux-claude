/**
 * The plugin as Claude Code runs it: spawned over stdio by an MCP client,
 * pointed at a stub of the Orknux door. Checks each of the four things it does:
 * a message from Orknux becomes a <channel> event, the reply tool posts back,
 * an approval request is shown in Orknux, and a verdict from Orknux goes back
 * to Claude Code. The server's half is ClaudeCodeChatsTest.
 *
 *   test/run.sh
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TOKEN = 'orkx_test'
/** What the pairing link's code is traded for: a second person's credential, to see the live poll move over. */
const SECOND = 'orkxc_second'
const polls: string[] = []
const commands: unknown[] = []
const posted: { path: string; body: any; auth: string | null }[] = []
const mcpCalls: string[] = []
const paired: any[] = []
const STATE = mkdtempSync(join(tmpdir(), 'orknux-state-'))
let failures = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ' - ' + detail : ''}`)
  if (!ok) failures++
}

const stub = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/api/client/compatibility') return Response.json({ compatible: true })
    if (url.pathname === '/api/clients/pair' && req.method === 'POST') {
      const asked = (await req.json()) as any
      paired.push(asked)
      const code = asked.code.toUpperCase().replace('-', '')
      return code === 'K7P4QX'
        ? Response.json({ credential: TOKEN, user: 'alice' })
        : code === 'U7NHQE'
          ? Response.json({ credential: SECOND, user: 'bob' })
          : Response.json({ error: 'That pairing code is not valid.' }, { status: 400 })
    }
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${SECOND}`) return new Response(null, { status: 401 })
    if (url.pathname === '/api/claude/hello') return Response.json({ user: auth === `Bearer ${SECOND}` ? 'bob' : 'alice' })
    // The workspace's MCP server, as Orknux answers it: JSON-RPC over POST, no stream.
    if (url.pathname === '/mcp/7') {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      const rpc = (await req.json()) as any
      if (rpc.id === undefined) return new Response(null, { status: 202 })
      const result =
        rpc.method === 'initialize'
          ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'orknux', version: '1.3.6' } }
          : rpc.method === 'tools/list'
            ? { tools: [{ name: 'orknux_diagram', description: 'Reads a diagram.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }] }
            : rpc.method === 'tools/call'
              ? { content: [{ type: 'text', text: `called ${rpc.params.name} with ${JSON.stringify(rpc.params.arguments)}` }] }
              : null
      mcpCalls.push(rpc.method)
      return Response.json(result === null ? { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'no' } } : { jsonrpc: '2.0', id: rpc.id, result })
    }
    if (url.pathname === '/api/claude/next') {
      polls.push(auth!)
      const next = commands.shift()
      if (next) return Response.json(next)
      await Bun.sleep(100)
      return new Response(null, { status: 204 })
    }
    if (req.method === 'POST') {
      posted.push({ path: url.pathname, body: await req.json(), auth: req.headers.get('authorization') })
      return new Response(null, { status: url.pathname.endsWith('replies') && posted.at(-1)!.body.chat_id === 'nope' ? 404 : 204 })
    }
    return new Response(null, { status: 404 })
  },
})

const notifications: { method: string; params: any }[] = []
const client = new Client({ name: 'claude-code-stand-in', version: '0.0.0' })
client.fallbackNotificationHandler = async (n) => {
  notifications.push(n as any)
}
await client.connect(
  new StdioClientTransport({
    command: 'bun',
    // The bundle, which is what Claude Code starts: no install, no network.
    args: ['dist/server.js'],
    env: {
      ...process.env,
      ORKNUX_URL: `http://127.0.0.1:${stub.port}/`,
      // A pairing code, as Orknux shows it: traded for the session's own credential at start.
      ORKNUX_TOKEN: 'k7p-4qx',
      ORKNUX_STATE_DIR: STATE,
    } as Record<string, string>,
  }),
)

const capabilities = client.getServerCapabilities() as any
check('it declares itself a channel, with approvals and tools', !!capabilities?.experimental?.['claude/channel'] && !!capabilities?.experimental?.['claude/channel/permission'] && !!capabilities?.tools)
check('it tells Claude to answer with the reply tool', (client.getInstructions() ?? '').includes('reply tool'))

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await Bun.sleep(25)
  return ok()
}

// The check: sent at start, and nothing collected until the session answers it - a Claude Code without the channel
// never does, and so never takes a message it would drop.
const isCheck = (n: { method: string; params: any }) => n.method === 'notifications/claude/channel' && n.params?.meta?.check === 'heard'
await until(() => notifications.some(isCheck))
check('it asks the session whether it hears the channel', notifications.some(isCheck), JSON.stringify(notifications))
await Bun.sleep(300)
check('and collects no messages until it is answered', polls.length === 0, `${polls.length} polls`)
const heardAnswer = await client.callTool({ name: 'orknux_heard', arguments: {} })
check('answered, it says heard', JSON.stringify(heardAnswer.content).includes('heard') && !heardAnswer.isError)
await until(() => polls.length > 0)
check('and starts collecting messages', polls.length > 0)

await until(() => paired.length > 0)
check('a pairing code is traded once, as Claude Code', paired.length === 1 && paired[0].client === 'ClaudeCode', JSON.stringify(paired))
await until(() => { try { return readFileSync(join(STATE, '.env'), 'utf8').includes(TOKEN) } catch { return false } })
check('and the credential replaces the code in the .env', (() => { try { const env = readFileSync(join(STATE, '.env'), 'utf8'); return env.includes(`ORKNUX_TOKEN=${TOKEN}`) && !env.includes('k7p') } catch { return false } })())

commands.push({ id: '1', action: 'message', arguments: { chat_id: '42', chat_title: 'Plans', workspace_id: '7', text: 'list the files' } })
await until(() => notifications.some((n) => n.method === 'notifications/claude/channel' && !isCheck(n)))
const event = notifications.find((n) => n.method === 'notifications/claude/channel' && !isCheck(n))
check('a message from Orknux becomes a channel event, with where it came from', event?.params?.content === 'list the files' && event?.params?.meta?.chat_id === '42' && event?.params?.meta?.chat_title === 'Plans' && event?.params?.meta?.workspace_id === '7', JSON.stringify(event))

const tools = await client.listTools()
check('it offers connecting, the workspace tools, the check and a reply tool', tools.tools.map((t) => t.name).sort().join() === 'orknux_call,orknux_connect,orknux_heard,orknux_tools,reply', tools.tools.map((t) => t.name).join())

const listed = await client.callTool({ name: 'orknux_tools', arguments: { workspace_id: '7' } })
check("orknux_tools lists the workspace's own tools, from its MCP server", JSON.stringify(listed.content).includes('orknux_diagram') && !listed.isError, JSON.stringify(listed.content))
const called = await client.callTool({ name: 'orknux_call', arguments: { workspace_id: '7', name: 'orknux_diagram', arguments: { id: '3' } } })
check('orknux_call calls one of them as the person', JSON.stringify(called.content).includes('called orknux_diagram with {\\"id\\":\\"3\\"}') && mcpCalls.includes('initialize'), JSON.stringify(called.content))
const nowhere = await client.callTool({ name: 'orknux_tools', arguments: { workspace_id: 'x' } })
check('a workspace that is not a number is refused in words', !!nowhere.isError)
const replied = await client.callTool({ name: 'reply', arguments: { chat_id: '42', text: 'Here they are.' } })
const reply = posted.find((p) => p.path === '/api/claude/replies')
check('the reply tool posts to Orknux, signed with the token', reply?.body?.chat_id === '42' && reply?.body?.text === 'Here they are.' && reply?.auth === `Bearer ${TOKEN}`)
check('and tells Claude it was sent', JSON.stringify(replied.content).includes('sent') && !replied.isError)
const refused = await client.callTool({ name: 'reply', arguments: { chat_id: 'nope', text: 'x' } })
check('a chat that is not the person\'s is said to Claude as not sent', !!refused.isError, JSON.stringify(refused.content))

await client.notification({
  method: 'notifications/claude/channel/permission_request',
  params: { request_id: 'abcde', tool_name: 'Bash', description: 'List files', input_preview: '{"command":"ls"}' },
} as any)
await until(() => posted.some((p) => p.path === '/api/claude/permissions'))
const asked = posted.find((p) => p.path === '/api/claude/permissions')
check('an approval Claude Code wants is shown in Orknux', asked?.body?.request_id === 'abcde' && asked?.body?.tool_name === 'Bash', JSON.stringify(asked?.body))

commands.push({ id: '2', action: 'permission', arguments: { request_id: 'ABCDE', behavior: 'allow' } })
await until(() => notifications.some((n) => n.method === 'notifications/claude/channel/permission'))
const verdict = notifications.find((n) => n.method === 'notifications/claude/channel/permission')
check('the answer from Orknux goes back to Claude Code as a verdict', verdict?.params?.request_id === 'abcde' && verdict?.params?.behavior === 'allow', JSON.stringify(verdict))
check('and never as a message to Claude', notifications.filter((n) => n.method === 'notifications/claude/channel' && !isCheck(n)).length === 1)

// A pairing link pasted into the session: the running channel moves to it, with no restart.
const BASE = `http://127.0.0.1:${stub.port}`
const bad = await client.callTool({ name: 'orknux_connect', arguments: { link: `${BASE}/pair/ZZZ-ZZZ` } })
check('a pairing link with a code Orknux refuses is said to Claude in words', !!bad.isError && JSON.stringify(bad.content).includes('not valid'), JSON.stringify(bad.content))
const switched = await client.callTool({ name: 'orknux_connect', arguments: { link: `${BASE}/pair/u7n-hqe` } })
check('a pairing link connects at once, and says as whom', !switched.isError && JSON.stringify(switched.content).includes('as bob'), JSON.stringify(switched.content))
const pollsBefore = polls.length
await until(() => polls.slice(pollsBefore).includes(`Bearer ${SECOND}`))
check('and the live poll moves to the new credential, no restart', polls.slice(pollsBefore).includes(`Bearer ${SECOND}`), polls.slice(-3).join())
await Bun.sleep(400)
const later = polls.slice(polls.length - 3)
check('and the old one stops asking', later.length > 0 && later.every((one) => one === `Bearer ${SECOND}`), later.join())
check('and the .env is the new server and credential', readFileSync(join(STATE, '.env'), 'utf8') === `ORKNUX_URL=${BASE}\nORKNUX_TOKEN=${SECOND}\n`)
const leaked = JSON.stringify(switched.content).includes(SECOND)
check('the credential is never shown to Claude', !leaked)

await client.close()

// Installed and never configured: it still starts, says it is not connected, and connects from a link.
const FRESH = mkdtempSync(join(tmpdir(), 'orknux-fresh-'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORKNUX_'))) as Record<string, string>
const fresh = new Client({ name: 'claude-code-stand-in', version: '0.0.0' })
await fresh.connect(new StdioClientTransport({ command: 'bun', args: ['dist/server.js'], env: { ...env, ORKNUX_STATE_DIR: FRESH } }))
check('unconfigured, it starts and tells Claude it is not connected, and how', (fresh.getInstructions() ?? '').includes('NOT connected') && (fresh.getInstructions() ?? '').includes('orknux_connect'))
const early = await fresh.callTool({ name: 'reply', arguments: { chat_id: '1', text: 'x' } })
check('and its other tools say so rather than fail', !!early.isError && JSON.stringify(early.content).includes('Not connected'), JSON.stringify(early.content))
const freshPolls = polls.length
await Bun.sleep(300)
check('and it asks Orknux nothing', polls.length === freshPolls)
const joined = await fresh.callTool({ name: 'orknux_connect', arguments: { link: `${BASE}/pair/K7P-4QX` } })
check('a pairing link connects it', !joined.isError && JSON.stringify(joined.content).includes('as alice'), JSON.stringify(joined.content))
check('and says messages come once the session answers the check', JSON.stringify(joined.content).includes("answered the channel"), JSON.stringify(joined.content))
await Bun.sleep(300)
check('a session that has not answered asks Orknux nothing, connected or not', polls.length === freshPolls)
await fresh.callTool({ name: 'orknux_heard', arguments: {} })
await until(() => polls.length > freshPolls)
check('and once it has, it starts asking for messages', polls.length > freshPolls)
await fresh.close()
stub.stop(true)
console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
