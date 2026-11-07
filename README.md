# Orknux channel for Claude Code

Talk to your Claude Code session from Orknux. Pick **My Claude Code**:

- in a chat's agent picker - what you write arrives in this session, and
  Claude's answers come back into the chat;
- in the assistant of a document, diagram, wireframe or sheet - Claude Code
  changes the item itself through the workspace's Orknux tools, and the page
  reloads it;
- in Quick Chat (Ask AI), under *Answered by*.

Tool approvals Claude Code asks for are shown where you asked, and answered
there.

Offered on every Orknux server, in the browser and in the desktop app. Nobody
else on that server sees or reaches your Claude Code: each message goes only to
the Claude Code of the person whose chat it is.

## What stays where

Orknux carries text and nothing else. This Claude Code session does every model
call, signed in however you signed it in, and Orknux never sees, stores or uses
a Claude credential. Each chat reaches only the Claude Code of the person whose
chat it is: the plugin signs in with that person's own Orknux token.

My Claude Code is a conversation, not a model: Orknux agents, workflows,
triggers and schedules never run on it. They run on the model providers
configured in Orknux.

## Install

Requires [Bun](https://bun.sh), like Anthropic's own channel plugins. The
plugin ships as one bundled file (`dist/server.js`), so starting it installs
nothing and needs no network.

In Claude Code:

```
/plugin marketplace add orknux/orknux-claude
/plugin install orknux@orknux
```

Start Claude Code with the channel (see **Start** below). Then, in Orknux,
open **Preferences › Connected clients**, press **Connect a client**, copy the
pairing link it shows and paste it into the session:

```
connect to Orknux: https://orknux.example.com/pair/K7P-4QX
```

Claude calls the channel's `orknux_connect` tool, which trades the code for a
credential of its own and connects at once - no restart, nothing to edit. The
credential opens only the doors the Orknux clients use, and any account can
pair, one from a directory too. `/orknux:configure <link>` does the same, and a
server address with a **read and write** access token works in place of a link.

What it connected to is kept in `~/.claude/channels/orknux/.env`, readable only
by you, so the next start connects by itself.

## Start

Channels are a research preview in Claude Code, and during it only channels on
Anthropic's approved list load with `--channels`. Until this one is listed,
start Claude Code with the development flag:

```
claude --dangerously-load-development-channels plugin:orknux@orknux
```

Claude Code asks you to confirm once per start. Then open Orknux, start a chat,
and pick **My Claude Code**. The corner of Orknux shows **Claude Code
connected** while this session is running.

Approvals: answer `yes abcde` or `no abcde` in the chat, as the message there
says, or in this terminal; whichever comes first counts. To stop being asked
for the reply tool every time, allow `mcp__plugin_orknux_orknux__reply` in
Claude Code's permissions.

## How it works

The plugin is an MCP server Claude Code starts over stdio. It holds a long
poll open to `GET /api/claude/next` on your Orknux - the same door the Orknux
Chrome extension and Orknux for Windows use - and pushes each message into the
session as a `<channel>` event. Claude answers with the `reply` tool, which
posts to `/api/claude/replies`. Nothing listens on your machine.

It also brings two tools, `orknux_tools` and `orknux_call`, which reach the
workspace's own MCP server (`/mcp/{workspace}`) with your token, through the
official MCP client - so Claude Code can read and change what a page is about
without a second server to set up.

## Building

`server.ts` is the source; `dist/server.js` is what Claude Code starts, built
with its dependencies inside. Rebuild it after any change and commit both:

```
bun run build
```

## Checking it

```
test/run.sh
```

Runs the plugin the way Claude Code does, spawned over stdio by an MCP client,
against a stub Orknux, and checks messages, replies, approvals and verdicts.
The server's half is `ClaudeCodeChatsTest` in orknux-server.
