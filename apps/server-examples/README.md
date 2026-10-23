# Server integration examples

These development-only examples live in their own workspace package, so a production
install of `@open-agent-tools/server` does not include LangChain, LangGraph or PDF loader
dependencies.

- `pnpm --filter @open-agent-tools/server-examples langgraph` runs a local state graph
  without an external model.
- `pnpm --filter @open-agent-tools/server-examples langchain /absolute/path/to/document.pdf`
  demonstrates prompt composition and PDF splitting. Configure this package's `.env` and
  `.env.local` for model initialization; JSON samples are written beside the example. The
  LLM invocation remains commented out.
- `pnpm --filter @open-agent-tools/server-examples typecheck` checks both examples without
  running them or contacting an LLM.

The RAG package keeps its own LangChain dependencies because production ingest code uses
them. The server package no longer declares or builds these examples.
