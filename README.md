# OpenClaw Console

OpenClaw Console is a Node.js + Express web console for managing tasks, execution queues, sessions, subagents (Local/Gateway), skills, and runtime status.

## Features

- Task management: create, update, delete, and execute tasks
- Execution queue: enqueue tasks, cancel runs, inspect results
- Session management: view history, send messages, create/terminate sessions
- Agent management: local subagents and Gateway subagents
- Schedules: inspect and run scheduled jobs
- Skill management: browse and edit `SKILL.md`

## Requirements

- Node.js 18+ (recommended)
- npm
- Optional: `openclaw` CLI (required for Gateway/session/subagent operations)

## Quick Start

```bash
git clone <your-repo-url>
cd openclaw-console
npm install

# Strongly recommended: override default credentials
export CONSOLE_AUTH_USER=admin
export CONSOLE_AUTH_PASS='your-strong-password'

npm start
```

Then open:

- `http://localhost:8200`

If environment variables are not set, default credentials are:

- Username: `admin`
- Password: `change-me`

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8200` | Console listen port |
| `CONSOLE_AUTH_USER` | `admin` | Basic Auth username |
| `CONSOLE_AUTH_PASS` | `change-me` | Basic Auth password (change this in real usage) |
| `OPENCLAW_CALL_MODULE_PATH` | empty | Optional path to OpenClaw Gateway call module |

## OpenClaw CLI Dependency

The UI can start without `openclaw`, but these features require an available `openclaw` command:

- Gateway connection and RPC calls
- Session operations
- Gateway subagent operations

Check installation:

```bash
openclaw --version
```

## Scripts

```bash
npm start
npm run dev
```

Currently both scripts run `node server.js`.

## API Docs

External API reference:

- [`API_EXTERNAL.md`](./API_EXTERNAL.md)

## Troubleshooting

### 1) README not shown on GitHub

Make sure `README.md` exists at the repository root and is committed on the default branch.

### 2) 401 / Authentication failed

The app uses Basic Auth. Ensure your browser credentials match `CONSOLE_AUTH_USER` and `CONSOLE_AUTH_PASS`.

### 3) Gateway not connected

- Confirm `openclaw` is installed and executable
- Verify Gateway service is running
- Refresh the page or call `/api/gateway/connect`

## License

Add a `LICENSE` file before publishing publicly.
