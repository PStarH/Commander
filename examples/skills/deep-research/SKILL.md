---
name: deep-research
description: "Perform deep multi-source research on a topic. Trigger when user asks for comprehensive analysis, deep dive, or thorough investigation of a topic."
version: "1.0.0"
author: "Commander Team"
license: "MIT"
argument-hint: <topic>
allowed-tools: web_search web_fetch file_write file_read
metadata:
  category: research
  tags: [research, analysis, web-search, synthesis]
  source: community
  quality_score: 0.8
---

# Deep Research Protocol

When this skill is activated, follow this structured research process:

## Phase 1: Query Expansion
Generate 3-5 search queries from different angles:
- Core topic query (exact match)
- Related concepts query (broader context)
- Recent developments query (add "2025 2026" or "latest")
- Expert opinions query (add "expert opinion" or "analysis")
- Contrarian query (add "criticism" or "limitations")

## Phase 2: Source Collection
For each query:
1. Search using `web_search`
2. Select the top 3 most relevant and diverse results
3. Fetch full content using `web_fetch`
4. Extract key facts, data points, and quotes

## Phase 3: Cross-Reference & Verification
- Compare findings across sources
- Identify consensus points (multiple sources agree)
- Flag contradictions (sources disagree)
- Note confidence levels for each finding

## Phase 4: Synthesis
Create a structured report with:

### Executive Summary
3-5 sentences capturing the most important findings.

### Key Findings
Bullet-pointed findings, each with:
- The finding itself
- Supporting evidence (which sources)
- Confidence level: High / Medium / Low

### Detailed Analysis
Organized by subtopic or theme.

### Open Questions
What remains uncertain or needs further investigation.

### Sources
Numbered list of all sources with URLs and access dates.

## Output Format
Save the report to `research/<topic-slug>.md` using the file_write tool.

## Quality Checklist
- [ ] At least 5 distinct sources consulted
- [ ] Cross-referenced findings across 2+ sources
- [ ] Contradictions explicitly noted
- [ ] Confidence levels assigned
- [ ] All claims have source attribution
- [ ] Executive summary is under 100 words
