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
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TOKEN = 'orkx_test'
const commands: unknown[] = []
const posted: { path: string; body: any; auth: string | null }[] = []
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
    if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 })
    if (url.pathname === '/api/claude/next') {
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
    args: ['server.ts'],
    env: {
      ...process.env,
      ORKNUX_URL: `http://127.0.0.1:${stub.port}/`,
      ORKNUX_TOKEN: TOKEN,
      ORKNUX_STATE_DIR: mkdtempSync(join(tmpdir(), 'orknux-state-')),
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

commands.push({ id: '1', action: 'message', arguments: { chat_id: '42', chat_title: 'Plans', text: 'list the files' } })
await until(() => notifications.some((n) => n.method === 'notifications/claude/channel'))
const event = notifications.find((n) => n.method === 'notifications/claude/channel')
check('a message from Orknux becomes a channel event', event?.params?.content === 'list the files' && event?.params?.meta?.chat_id === '42' && event?.params?.meta?.chat_title === 'Plans', JSON.stringify(event))

const tools = await client.listTools()
check('it offers exactly a reply tool', tools.tools.map((t) => t.name).join() === 'reply')
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
check('and never as a message to Claude', notifications.filter((n) => n.method === 'notifications/claude/channel').length === 1)

await client.close()
stub.stop(true)
console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
