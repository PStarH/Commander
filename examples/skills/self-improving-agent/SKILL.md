---
name: self-improving-agent
description: "Continuous learning from errors and successes. Trigger after task completion to log learnings, or when the agent encounters errors it should remember for next time."
version: "1.0.0"
author: "Commander Team"
license: "MIT"
allowed-tools: file_read file_write file_list memory_store memory_recall
metadata:
  category: strategy
  tags: [learning, self-improvement, reflection, memory]
  source: community
  quality_score: 0.8
---

# Self-Improving Agent Protocol

This skill enables continuous learning from task execution. After completing tasks (especially those with errors), log learnings to improve future performance.

## When to Activate

1. **After an error**: When a tool call fails or produces unexpected results
2. **After task completion**: When a complex task is finished
3. **When discovering a pattern**: When you notice a recurring issue or shortcut
4. **On user correction**: When the user points out a mistake

## Learning Log Format

Create/update a learning entry in `.commander/learnings/`:

```markdown
## [Topic]
- **Date**: YYYY-MM-DD
- **Context**: What was being attempted
- **Error/Observation**: What went wrong or what was noticed
- **Root Cause**: Why it happened
- **Solution/Fix**: How to prevent it next time
- **Confidence**: high/medium/low
- **Tags**: [relevant, tags]
```

## Learning Categories

### 1. Error Patterns
Log when tools fail and why:
- API rate limits → implement backoff
- File not found → check path resolution
- Type errors → validate inputs first

### 2. User Preferences
Log when user corrects behavior:
- "Don't use that library" → avoid in future
- "Always use TypeScript" → prefer TS
- "Be more concise" → adjust output style

### 3. Environment Quirks
Log platform-specific issues:
- macOS vs Linux path differences
- Node.js version compatibility
- Package manager quirks (pnpm vs npm)

### 4. Workflow Optimizations
Log shortcuts discovered:
- Parallel tool calls for independent tasks
- Cache-friendly patterns
- Token-saving techniques

## Storage Location

Learnings are stored in:
- `.commander/learnings/` (project-local)
- `~/.commander/learnings/` (global patterns)

## Integration with Memory

When a learning is confirmed (used successfully 3+ times):
1. Promote to `memory_store` for faster recall
2. Consider adding to a relevant SKILL.md
3. Share with team if using shared workspace

## Example

After a failed shell command:
```
## Shell Command Escaping
- **Date**: 2026-06-01
- **Context**: Running `grep -r "pattern" ./src/`
- **Error**: Shell interpreted special characters
- **Root Cause**: Unescaped quotes in command string
- **Solution**: Use array form or escape special chars
- **Confidence**: high
- **Tags**: [shell, escaping, debugging]
```
