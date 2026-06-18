---
name: brave-web-search
description: 'Use Brave Search API for web searches. Trigger when user asks to search the web, find information online, or research a topic. Requires BRAVE_SEARCH_API_KEY environment variable.'
version: '1.0.0'
author: 'Commander Team'
license: 'MIT'
argument-hint: <query>
allowed-tools: web_search web_fetch shell_execute
metadata:
  category: research
  tags: [web-search, brave, research, api]
  source: community
  quality_score: 0.9
---

# Brave Web Search

Use the Brave Search API for comprehensive web searches. This skill teaches you how to use the `web_search` tool effectively with Brave Search.

## Setup

Ensure the `BRAVE_SEARCH_API_KEY` environment variable is set. Get a free API key at https://api.search.brave.com

## Basic Search

Use the `web_search` tool with your query:

```
web_search("your search query here")
```

## Advanced Search Strategies

### 1. Multi-Query Research

For thorough research, generate 3-5 query variations:

- Exact topic query
- Related concepts query
- Recent developments (append year: "2026")
- Expert opinions (append "expert analysis" or "deep dive")
- Contrarian view (append "criticism" or "limitations")

### 2. Refining Results

If initial results are too broad:

- Add specificity: "Python async" → "Python asyncio event loop internals"
- Use quotes for exact phrases: `"machine learning" "production deployment"`
- Exclude terms: `python -snake -monty`

### 3. Freshness Filtering

For recent information, add time-related terms:

- "latest", "recent", "2026"
- "breaking" for news

## Processing Results

After getting search results:

1. **Extract key facts** from snippets
2. **Fetch full pages** with `web_fetch` for important results
3. **Cross-reference** findings across multiple sources
4. **Note confidence** — consensus across 3+ sources = high confidence

## Output Format

When presenting search results:

- Source name and URL
- Key finding (1-2 sentences)
- Relevance rating (high/medium/low)
- Publication date if available

## Error Handling

If `BRAVE_SEARCH_API_KEY` is not set:

- Inform the user to set the environment variable
- Suggest alternative: use `web_search` tool which may use a different provider

## Example Workflow

User: "Research the current state of quantum computing"

1. Search: "quantum computing 2026 state of the art"
2. Search: "quantum computing breakthroughs recent"
3. Search: "quantum computing practical applications"
4. Fetch top 3 most relevant articles
5. Synthesize findings into structured report
