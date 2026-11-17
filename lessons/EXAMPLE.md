# opencode error and fix (example)

SYMPTOM: Unknown tool 'webfetch.webfetch'
CAUSE: built-in tools are called directly, not through execute
FIX: call webfetch as a separate tool; execute is only for tools.* of MCP servers
EXAMPLE: webfetch({url: "https://example.com"})
