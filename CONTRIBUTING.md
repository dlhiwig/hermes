# Contributing to Hermes

## Running Tests

```bash
npm test           # Run all tests (vitest)
npm run build      # Type-check and compile
```

All PRs must pass `npm test` and `npm run build` with zero errors.

## Adding a New VoltAgent Role

1. Open `src/agents/voltagent-ollama.ts`
2. Add your role to the `AGENT_ROLES` array with:
   - `role`: unique identifier
   - `model`: Ollama model name (e.g., `qwen3.5`, `dolphin-llama3`)
   - `systemPrompt`: role-specific instructions
3. Add a test case in `tests/` covering the new role

## Adding a New MCP Tool

1. Open `src/mcp/server.ts`
2. Add a tool definition to the `TOOLS` array with `name`, `description`, and `inputSchema`
3. Add the handler in the `handleToolCall` switch block
4. Test via `curl -X POST http://localhost:18806 -d '{"method":"tools/call","params":{"name":"your_tool"}}'`

## Adding a New Skill to ReasoningBank

1. Create `skills/auto/<skill-name>/SKILL.md` following the format in `.claude/CLAUDE.md`
2. Required frontmatter: `name`, `description` (trigger conditions)
3. Required sections: Overview, When to Use, Core Pattern, Quick Reference, Common Mistakes
4. Skills are auto-discovered by Claude Code sessions

## Code Style

- TypeScript strict mode, no `any` types
- Tests required for all new functionality
- Use existing patterns from `src/core/loop.ts` as reference
- Keep kill switch limits (see `.claude/CLAUDE.md`) — never bypass
