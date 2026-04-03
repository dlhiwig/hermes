# Hermes Integration Guide

Practical guide for using Hermes from external tools and interfaces.

## Port Reference

| Service           | Port  | Protocol       |
|-------------------|-------|----------------|
| RuVector (Qdrant) | 18803 | HTTP (REST)    |
| SONA daemon       | 18805 | HTTP (REST)    |
| MCP server        | 18806 | HTTP (JSON-RPC)|

## Using Hermes MCP Tools from Claude Code

Hermes ships a `.mcp.json` in the repo root. Claude Code auto-discovers it.

Available MCP tools:
- `hermes_run_task` — Run a task through the 8-step loop
- `hermes_sona_stats` — Get SONA optimization statistics
- `hermes_list_skills` — List available ReasoningBank skills
- `hermes_ledger_run` — Run the ledger skill
- `hermes_metrics` — Get observability metrics

To use manually, start the MCP server:

```bash
npm run dev  # or: tsx src/mcp/server.ts
```

Then point Claude Code at `http://localhost:18806`.

## Telegram Bot

Send commands to the Hermes Telegram bot:

- `/hermes <task>` — Submit a task to the 8-step loop
- `/hermes-status` — Check loop status and SONA stats

Requires `TELEGRAM_BOT_TOKEN` in your environment.

## Running the Ledger Skill

The ledger skill demonstrates financial trajectory processing through SONA:

```bash
npm run ledger:run
```

## Multi-Turn Demo

Run the interactive demo to see multi-turn loop execution:

```bash
npm run demo:mock   # Mock mode (no external dependencies)
npm run demo:fast   # Fast mode (shorter timeouts)
npm run demo:multi  # Full demo
```

## Checking SONA Stats

With the SONA daemon running (`npm run sona:daemon`):

```bash
curl http://localhost:18805/sona/stats
```

Returns trajectory counts, EWC++ state, and ReasoningBank metrics.

## Checking Metrics

With the MCP server running:

```bash
curl http://localhost:18806/metrics
```

Returns step durations, error counts, and loop execution summaries.

## Always-On Mode

Start Hermes in always-on mode for continuous loop execution:

```bash
npm run start:dev -- --always-on
```

This runs the 8-step loop on a recurring interval, processing queued tasks automatically. Use systemd units (see `config/`) for production deployment.
