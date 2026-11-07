---
name: configure
description: Set up the Orknux channel - save the Orknux server address and access token. Use when the user pastes an Orknux address or an orkx_ token, asks to configure Orknux, asks how to connect this session to Orknux, or wants to check the channel's status.
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

Writes the Orknux server address and the person's access token to
`<state-dir>/.env`. The channel reads it when the session starts.

**Resolve the state directory first:**

```bash
echo "${ORKNUX_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/orknux}"
```

Use the printed path everywhere below in place of `<state-dir>`.

Arguments passed: `$ARGUMENTS`

## No arguments - status

Read `<state-dir>/.env` and say:

1. **Server** - `ORKNUX_URL`, or that it is not set.
2. **Token** - set or not; if set, show only its first 9 characters (`orkx_abcd…`). Never print the rest.
3. **What next**:
   - Nothing set: "Run `/orknux:configure <server> <token>`. The server is the
     address you open Orknux at, such as `http://127.0.0.1:8080`; make a
     **read and write** token on your Orknux profile page."
   - Both set: "Ready. Restart Claude Code with the channel on (see the
     README), then pick **My Claude Code** in an Orknux chat."

## `<server> <token>` - save them

1. The server is the first argument without a trailing `/`; it must start with
   `http://` or `https://`. The token is the second and starts with `orkx_`.
   Anything else: say what is wrong and stop.
2. Check it before saving:
   `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer <token>" <server>/api/claude/hello`
   - `200`: good.
   - `401`: the token is wrong or was deleted. Stop.
   - `404`: this Orknux is not a local edition (the desktop app or orknux-one),
     or is older than My Claude Code. Stop and say so.
   - Anything else, or nothing: the server cannot be reached from here. Save
     anyway only if the user says so.
3. `mkdir -p <state-dir>`, then write `<state-dir>/.env` with exactly:

   ```
   ORKNUX_URL=<server>
   ORKNUX_TOKEN=<token>
   ```

   and `chmod 600 <state-dir>/.env`.
4. Tell the user to restart Claude Code with the channel on, as the README
   says, and that the token is now readable only by their account.

## `clear`

Delete `<state-dir>/.env` and say the channel will stay unconfigured until
`/orknux:configure` is run again.
