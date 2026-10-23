<div align="center">
  <img src="icon.svg" alt="Our Free Model for Codex" width="110">

# codex-our-free-model

**Free frontier models, right inside Codex.** No login, no sign-up, no API key.

**简体中文** | [English](README.md) ← *(this file)*

</div>

---

## What this is

A Codex plugin. Install it and free frontier models — DeepSeek V4.1 Flash, Kimi K3 and the rest — appear in **Codex's own model picker**, behaving exactly like any other provider.

It does two things:

1. Runs a local gateway that speaks the `responses` wire — the only one Codex accepts.
2. Registers that gateway as `[model_providers.our-free-model]` and feeds its roster into Codex's picker.

The free models come from [OpenCode's public Zen free pool](https://opencode.ai), reached directly, with no third-party relay in between.

> **Porting note**: this project is the Codex version of [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model). The original is a DSH (DeepSeek Harness) plugin; this keeps the host-independent free-lane core and drops the DSH-specific host layer (settings UI, in-app updater, announcement feed, and the EAC/Kilo/LobsterAI account channels).

## Quick start

```bash
# 1. Install the plugin
codex plugin marketplace add bob97989/codex-our-free-model
codex plugin add codex-our-free-model@codex-our-free-model

# 2. Start the gateway and wire Codex to it
#    (the plugin is already on disk — run its CLI directly)
node ~/.codex/plugins/cache/codex-our-free-model/codex-our-free-model/1.1.0/bin/cli.mjs setup

# 3. Start a session on a free model
codex -m mimo-v2.6-flash-free -c model_provider=our-free-model
```

> Installed somewhere else? Run `codex plugin list --json` and use the
> `installedPath` it reports in place of the path above.

`setup` starts the gateway, verifies it answers, writes the provider block into
`~/.codex/config.toml`, and prints the available models.

**Or clone and run it directly** (works without installing the plugin):

```bash
git clone https://github.com/bob97989/codex-our-free-model
cd codex-our-free-model
node bin/cli.mjs setup
```

## Sidebar configuration

After installation, the plugin adds an **Our Free Model** entry to Codex's left
sidebar. If the gateway is not running yet, the panel can start it and write the
managed provider block without returning to the terminal.

The panel provides:

- **Models** — inspect free-pool and account models, toggle individual models,
  or hide a whole lane.
- **Accounts** — add API-key providers, override the base URL, supply model ids,
  test the connection, and discover the provider's live model listing.
- **Settings** — control inference, region-limited models, the free pool, and
  provider-account models.

Provider keys stay in the local `settings.json` file with mode 0600; the panel
only exposes the last four characters. Accounts use this project's existing
aggregate-provider lane. The DSH-only OAuth and cloud-credential sign-in
channels are not part of this Codex port.

To make it permanent, add two lines to `~/.codex/config.toml`:

```toml
model_provider = "our-free-model"
model = "mimo-v2.6-flash-free"
```

## Commands

| Command | What it does |
| --- | --- |
| `cofm setup [--port N] [--no-config]` | Start the gateway and write config.toml (`--no-config` skips the write) |
| `cofm run [--port N]` | Start the gateway only, touching no config |
| `cofm doctor` | End-to-end check: config block, gateway settings, reachability, model count |
| `cofm uninstall` | Remove the provider block from config.toml (data directory is kept) |

`cofm` is shorthand for `codex-our-free-model`.

## Two ways in

**As a model provider (the main path).** Free models appear in Codex's model picker; selecting one uses it for the whole session. Streaming, tool calls and usage are all real — not a translation shim.

**As MCP tools (the auxiliary path).** Three tools, without switching the session model:

| Tool | Purpose |
| --- | --- |
| `list_free_models` | The current roster |
| `ask_free_model` | One question to one free model, returns its answer |
| `gateway_status` | Whether the gateway is up, where, and serving how many models |

`ask_free_model` suits a self-contained single question — a second opinion, a quick factual check. It sends **only the prompt you give it**: no files, no conversation history, no tools. A task that needs to read code or edit files belongs in the session itself, on a free model selected as the provider.

## Troubleshooting

Two failures are normal and neither is a bug in this plugin:

- **`Free usage limit reached` (HTTP 429)** — the free pool meters per egress IP and yours is spent. The message carries a retry-after. It is not a configuration problem; the models return when the window resets.
- **`RegionError` (HTTP 403)** — the lane refuses this network egress. A different network or a proxy changes the verdict.

Check with `cofm doctor` first; it tells you whether the problem is the config block, the gateway process, or the upstream. **Never hand-edit the provider block** — it is marker-delimited (`# >>> our-free-model ... >>>`) and `cofm setup` overwrites it wholesale.

## How it works

```
Codex  ──(responses wire)──>  local gateway (127.0.0.1:random port)
                                 │
                                 ├─ /v1/responses          → the free lane
                                 ├─ /models/catalog        → roster for Codex's picker
                                 ├─ /v1/chat/completions   → other local tools
                                 └─ /v1/messages           → Anthropic clients
```

Three design decisions worth explaining:

**Why config.toml must be written.** Codex's plugin manifest (`plugin.json`) describes skills, MCP servers and hooks — but **not model providers**. A provider lives only in `config.toml`, so something has to write it. That is what `cofm setup` is for.

**Why /models/catalog.** `model_providers` accepts a `model_catalog_url`, and Codex pulls model metadata from it. The roster is regenerated from the live lane on every ask, so a model the upstream adds shows up in your picker without a plugin upgrade.

**Why the catalog is authenticated.** It describes your model pool, so it needs the gateway key like every other route. Codex sends the provider's bearer token on every request including the catalog fetch, so this costs it nothing.

## Where data lives

`~/.codex/our-free-model/` by default (`settings.json`, `stats.json`, `catalog.json`). Override with `COFM_HOME`; `CODEX_HOME` changes the default parent. Settings are mode 0600 and contain the gateway key. Usage statistics stay on this machine and are never uploaded.

## Known limits

- **The `responses` wire only.** Codex's `WireApi` has a single variant; `chat` is rejected when config is parsed.
- **Image input is off.** The catalog declares text only; the lane's image path exists but has not been verified under Codex.
- **The quota is shared.** The free pool meters per egress IP, so several machines behind one network share a single allowance.

## License

MIT. The upstream free lane's behaviour, availability and quota are decided by OpenCode, not by this project.

## Credits

The core free-lane logic and its fingerprint/gate adaptation come from
[dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) (MIT).
