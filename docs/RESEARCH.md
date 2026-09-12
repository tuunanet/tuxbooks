# External knowledge & source research

Use these tools when repository context alone is insufficient. Prefer the most
specific source for the question rather than a generic web search.

- **Context7 — official/current documentation:** Use for up-to-date,
  version-specific documentation, API references, configuration, and usage
  examples for libraries, frameworks, SDKs, and tools. Prefer Context7 over
  remembered API details.

- **GitHits — source-level investigation:** Use for open-source dependency
  internals, implementation details, call paths, version changes, existing
  patterns, and behavior that is unclear or undocumented. Prefer GitHits when
  debugging how a dependency actually works rather than simply learning its
  public API.

- **Firecrawl — web research:** Use `firecrawl-search` whenever information
  must be obtained from the public web, including current information,
  technical research, GitHub issues/discussions, release information,
  comparisons, news, prices, or other information not available in the
  repository or through Context7/GitHits. Prefer official documentation,
  upstream repositories, and other primary sources. Do not guess when
  external verification is available.

## Tool selection

1. Current library/API documentation → **Context7**
2. Dependency implementation or runtime behavior → **GitHits**
3. General/current information or web research → **Firecrawl**
4. If multiple sources are relevant, use them together and cross-check
   important technical conclusions.

Do not invoke graphify merely because the question is being asked from within
this repository. The question itself must concern the TuxBooks codebase.
