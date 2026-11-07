---
name: configure
description: Connect the Orknux channel - with the pairing link Orknux shows, or a server address and a pairing code or access token. Use when the user pastes an Orknux pairing link (https://.../pair/K7P-4QX), a pairing code or an orkx_ token, asks to connect or configure Orknux, or asks whether the channel is connected.
user-invocable: true
allowed-tools:
  - Read
  - mcp__plugin_orknux_orknux__orknux_connect
---

# /orknux:configure - connect the Orknux channel

Arguments passed: `$ARGUMENTS`

## A pairing link, or a server and a code or token

Call the channel's `orknux_connect` tool:

- a pairing link (`https://<their Orknux>/pair/K7P-4QX`) as `link`;
- otherwise the server address as `server` and the code or `orkx_` /
  `orkxc_` token as `code_or_token`.

It trades a code, checks Orknux takes it, saves it and connects the running
channel at once - no restart. Say what it answered. Never print a token.

If the tool is not there, the channel is not running in this session: start
Claude Code with `--dangerously-load-development-channels plugin:orknux@orknux`.

## No arguments - status

Read `${ORKNUX_STATE_DIR:-~/.claude/channels/orknux}/.env` and say the server
(`ORKNUX_URL`) and whether a token is set, showing at most its first 9
characters. If nothing is set: "In Orknux open Preferences › Connected clients
› Connect a client, copy the pairing link and paste it here."
