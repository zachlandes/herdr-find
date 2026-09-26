# herdr-find

Search what your agents in [herdr](https://herdr.dev) said, from a popup over the pane you are in.
It searches the agents you can see in herdr right now: the pane you opened it from, one agent, or all open agents.

Type to search the way you already know from fzf: fuzzy by default, or exact.
Press one key to search by meaning instead, which finds the message that answers your question even when it shares none of your words.
Meaning search is optional, off until you turn it on, and sends nothing until you do.

## What you need

- herdr 0.9 or newer
- [fzf](https://github.com/junegunn/fzf) 0.73 or newer on your `PATH`
- Node.js 20 or newer
- For meaning search only: a [TypeSafe](https://typesafe.ai) API key

## Install

```sh
herdr plugin install zachlandes/herdr-find
```

Then bind a key to open it, in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "zachlandes.find.open"
description = "find in open agents"
```

and reload herdr's config (`herdr server reload-config`).

herdr-find also works without the plugin, as a plain command.
Clone this repository and bind its `bin/herdr-find-plugin` as a herdr popup, by its full path.
herdr may run popups with only the system `PATH`, so that launcher first looks for node and fzf where they are usually installed: your own bin folders, nvm, fnm, asdf, volta, mise, Homebrew and `/usr/local`.

```toml
[[keys.command]]
key = "prefix+f"
type = "popup"
command = "/path/to/herdr-find/bin/herdr-find-plugin"
width = "90%"
height = "85%"
```

## Keys

| Key | What it does |
| --- | --- |
| `ctrl-s` | Switch between fuzzy, exact and meaning search. Your words stay in the box. |
| `alt-f` `alt-e` `alt-m` | Go straight to fuzzy, exact or meaning search. |
| `ctrl-o` | Change what is searched: this pane, then all open agents, then just the agent of the line you are on. |
| `enter` | Open the line in its whole conversation, at that line (`q` comes back). In meaning search, run the search first. |
| `ctrl-y` | Copy the whole highlighted message, with its original line breaks. |
| `alt-enter` | Go to that agent's pane. |
| `esc` | Close. |

Copy uses `pbcopy` on macOS, then `wl-copy` or `xclip` where available, and reports the result in the preview border.
The popup captures the mouse like fzf; Option-drag or Shift-drag selects text natively, depending on the terminal.

## What it searches

For Claude Code and Pi, herdr-find reads the agent's own conversation file, so it has the whole conversation, not just what is on screen.
It searches what you and the agent said to each other; tool calls, tool output and the agent's hidden reasoning are left out.
herdr tells it which conversation belongs to which agent; if herdr does not know, it uses the newest conversation in that agent's folder and says so in the preview.

A shell pane, or an agent herdr-find cannot read the conversation of yet, is searched through the last 1,000 lines herdr keeps for it.

## Meaning search

Fuzzy and exact search match letters.
Meaning search asks, for each message in the scope, whether it answers what you typed, so "how much are we allowed to spend each day" finds "Let's cap it at five dollars a day".
It replaces the list with what it found, best first, and shows the line that answers you.
Then typing narrows those results by letters, without asking again.

Meaning search uses TypeSafe's Jev model, so it costs money and sends text off your machine.
That is why it is off by default, and why it will not run until all of these are true:

1. It is turned on in `~/.config/herdr-find/config.json` (inside herdr, the plugin's config folder; `herdr plugin config-dir zachlandes.find` prints it):

   ```json
   { "meaning": { "enabled": true } }
   ```

   See [`examples/config.json`](examples/config.json) for every setting.
2. Your TypeSafe key is in `typesafe-api-key` in that folder, readable by you only (`chmod 600`), or in `TYPESAFE_API_KEY`.
3. You have a redaction list, `redaction.json` in that folder, readable by you only.
   It can be empty, `{ "rules": [], "forbidden": [] }`, but it has to be there, so turning meaning search on is a choice you make about what may leave your machine.

Until then, meaning mode says which of these is missing.

### What is sent, and what is not

- Sent: the words you typed and the text of the messages in the scope you chose, after redaction.
- Not added by herdr-find: pane or session ids, file names, your machine's name or folder names; each message goes under a number that only means something inside that one request.
- Messages that mention paths, folder names, your machine's name or user name are sent as they are, unless your redaction list replaces them.
  Shell prompts and agent conversations often do, so add your home folder and machine name to your list if they should not leave your machine.
- Before anything is sent, secret-looking text is replaced: API keys, tokens, `Authorization` headers, passwords in `name=value` pairs, private keys, passwords in URLs, email addresses and long random-looking strings.
  Your own list then replaces what no pattern can know, such as names, customers and internal hosts; see [`examples/redaction.json`](examples/redaction.json).
  Its `forbidden` patterns are a last check: if one still matches after redaction, that request is not sent.
- The record of each search keeps counts, time and cost only, never your words or any message text.
- A search that read everything it was asked to is kept while the popup is open, so switching to fuzzy or exact search and back shows its results again without asking again or paying again.
  Coming back to meaning search with ctrl-s or alt-m, with the same words and scope, shows the kept results; enter always runs a new search.
  A search that was stopped, reached a cap, or had requests fail or held back is still listed when it ends, but is not shown again when you come back to meaning search.
  It is kept in the popup's own private temporary folder as message ids, scores and counts only, and is removed when the popup closes.

### What it costs

Each search stops at a spend cap (USD 0.02 by default), and each day has one too (USD 0.20), both set in `config.json`.
Before you press enter, meaning mode shows how many messages the scope holds, about what the search will cost, the search cap and what is left of today's cap, for example `about USD 0.013 · never more than USD 0.02 per search · USD 0.187 left today`.
The cost shown is an estimate; a request the service has to retry is charged again.
The caps are the real limit: a search never spends more than its cap or what is left of today's.
Messages are read newest first, so when a search reaches its cap it is the oldest that go unread, and the result says how many were read.

For a sense of scale, measured on 2026-09-25 over nine open agents holding about 1,000 messages between them: the first matches showed after about 0.4 s, the whole search took 5 to 8 s, and each search cost about USD 0.013.
Fuzzy and exact search over the same nine agents open in about half a second and cost nothing.

## Other commands

```sh
herdr-find list --scope all                    # print what would be searched
herdr-find --scope agent:reviewer --mode exact  # open the search on one agent, in exact mode
```

## Development

```sh
npm test
```

The tests run against a stand-in for herdr and a stand-in for TypeSafe on your own machine, so they need neither a herdr session nor a key.
`test/fixtures/build.mjs` writes the made-up conversations they search.

## Releasing

Release Please keeps a release PR open from Conventional Commit titles merged into `main`.
Use `fix:` for a patch, `feat:` for a minor version, and `!` or a `BREAKING CHANGE:` footer for a major version; titles such as `ci:` and `docs:` do not trigger releases on their own.
The release PR updates `package.json` and `herdr-plugin.toml` together and generates `CHANGELOG.md`; never edit the changelog by hand.
Merge the release PR only on the maintainer's explicit word: merging it creates a GitHub release and tag on the next workflow run, but does not publish to npm or a marketplace.
The first herdr-find release must wait until it runs on jevzf's core and the maintainer approves it; do not tag, list it in a marketplace, or announce it before then.

## Credits

- [fzf](https://github.com/junegunn/fzf) by Junegunn Choi (MIT) does all the fuzzy and exact searching; herdr-find runs it as it is, unchanged.
- The meaning search questions are adapted from [Needle](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/advanced_llm_apps/needle) by Shubham Saboo, awesome-llm-apps (Apache-2.0); see [NOTICE](NOTICE).

## Licence

Apache-2.0; see [LICENSE](LICENSE).
