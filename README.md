# AI-SSH-Pro for VS Code / Cursor

Multi-session SSH client as a VS Code / Cursor extension (ported from the Electron app **without AI chat**).

**GitHub:** https://github.com/guoshuaipeng/ai-ssh-pro-vscode

## Features

- Multi-session SSH (password / private key / default `~/.ssh` keys)
- ProxyJump / bastion
- Local port forwarding
- Host key TOFU (trust once / always / reject)
- Native VS Code terminals via Pseudoterminal + `ssh2`
- SFTP panel (browse, upload, download, mkdir, rename, delete, edit & save)
- Session folders, save / edit / move / delete profiles
- Broadcast text to all active SSH sessions
- Import: Xshell `.xsh`, OpenSSH config, PuTTY, JSON
- Export: JSON / OpenSSH config (secrets stripped)
- Session recording to a local log file
- Command snippets (add / edit / run)
- Docker tree (containers / compose / swarm) + exec / logs / inspect / start / stop / restart / rm / compose up-down
- Host inventory (`~/.ai-ssh-pro/inventory`, shared with the Electron app & MCP)
- Optional local shell via `node-pty` (falls back to normal VS Code terminal)
- Secrets in VS Code `SecretStorage`; profiles in `~/.ai-ssh-pro/vscode-store.json`

## Install from Marketplace

Search **AI-SSH-Pro** in the Extensions view (publisher `guoshuaipeng`), or install from the [VS Code Marketplace](https://marketplace.visualstudio.com/) / Open VSX once published.

## Develop

```bash
npm install
npm run compile
```

Press **F5** (`Run Extension`) to open an Extension Development Host.

## Install locally (VSIX)

```bash
npm run package
# installs ai-ssh-pro-0.1.1.vsix
code --install-extension ai-ssh-pro-0.1.1.vsix
# or in Cursor:
cursor --install-extension ai-ssh-pro-0.1.1.vsix
```

## Usage

1. Open the **AI-SSH-Pro** activity bar icon
2. **Sessions** → New connection / connect a saved profile
3. Terminal opens in the panel
4. Right-click an active session → **Open SFTP** / Reconnect / Recording
5. **Docker** view refreshes against the active SSH session
6. **Snippets** / **Host Inventory** as needed
7. Command Palette: `AI-SSH-Pro: MCP Inventory Guide` for Cursor MCP setup

Command Palette: `AI-SSH-Pro: …`

## Privacy

Passwords and key passphrases are stored via the editor’s secret storage. Session metadata lives under `~/.ai-ssh-pro/`. Do not commit secrets.

## MCP inventory (optional)

Same as the desktop app:

```bash
npm run mcp:inventory
```

See **AI-SSH-Pro: MCP Inventory Guide** for sample Cursor MCP JSON (`scripts/mcp-inventory-server.mjs` + `~/.ai-ssh-pro/inventory`).

## License

MIT
