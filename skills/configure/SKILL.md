---
name: configure
description: Set up the Orknux channel - save the Orknux server address and a pairing code or access token. Use when the user pastes an Orknux address, a pairing code like K7P-4QX or an orkx_ token, asks to configure Orknux, asks how to connect this session to Orknux, or wants to check the channel's status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(echo *)
  - Bash(chmod *)
  - Bash(curl *)
---

# /orknux:configure - Orknux Channel Setup

Writes the Orknux server address and the person's credential to
`<state-dir>/.env`: the one a pairing code is traded for, or an access token. The channel reads it when the session starts.

**Resolve the state directory first:**

```bash
echo "${ORKNUX_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/orknux}"
```

Use the printed path everywhere below in place of `<state-dir>`.

Arguments passed: `$ARGUMENTS`

## No arguments - status

Read `<state-dir>/.env` and say:

1. **Server** - `ORKNUX_URL`, or that it is not set.
2. **Token** - set or not; if set, show only its first 9 characters (`orkxc_abc…`). Never print the rest.
3. **What next**:
   - Nothing set: "Run `/orknux:configure <server> <code>`. The server is the
     address you open Orknux at, such as `http://127.0.0.1:8080`; the code is
     from **Connect a client** in Orknux, under Preferences › Connected clients.
     A **read and write** access token works in its place."
   - Both set: "Ready. Restart Claude Code with the channel on (see the
     README), then pick **My Claude Code** in an Orknux chat."

## `<server> <code or token>` - save them

1. The server is the first argument without a trailing `/`; it must start with
   `http://` or `https://`. The second is either a **pairing code** - six
   letters and digits, usually with a dash, like `K7P-4QX` - or a token
   starting with `orkx_` or `orkxc_`. Anything else: say what is wrong and stop.
2. **A pairing code is traded first**, at once, since it works once and only
   for a few minutes:
   `curl -s -X POST -H "Content-Type: application/json" -d '{"code":"<code>","client":"ClaudeCode","name":"Claude Code"}' <server>/api/clients/pair`
   - It answers `{"credential":"orkxc_…","user":"…"}`: use that credential as
     the token from here on, and never print it whole.
   - It answers `{"error":"…"}`: say the error - usually the code was mistyped,
     used or ran out, and a new one is made in Orknux - and stop.
   - Nothing: the server cannot be reached from here. Stop.
3. Check the token before saving:
   `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer <token>" <server>/api/claude/hello`
   - `200`: good.
   - `401`: the token is wrong, was deleted, or the client was disconnected. Stop.
   - `404`: this Orknux is not a local edition (the desktop app or orknux-one),
     or is older than My Claude Code. Stop and say so.
   - Anything else, or nothing: the server cannot be reached from here. Save
     anyway only if the user says so.
4. `mkdir -p <state-dir>`, then write `<state-dir>/.env` with exactly:

   ```
   ORKNUX_URL=<server>
   ORKNUX_TOKEN=<token>
   ```

   and `chmod 600 <state-dir>/.env`.
5. Tell the user to restart Claude Code with the channel on, as the README
   says, and that the token is now readable only by their account.

## `clear`

Delete `<state-dir>/.env` and say the channel will stay unconfigured until
`/orknux:configure` is run again.
