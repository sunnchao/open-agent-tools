const DEFAULT_ENDPOINT = "https://tavily-proxy.deedvv.dev/api/tavily/search";
const TOPICS = new Set(["general", "news", "finance"]);
const DEPTHS = new Set(["basic", "advanced"]);

export function searchConfig(env = process.env) {
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not configured");
  }
  return {
    apiKey,
    endpoint: env.TAVILY_SEARCH_URL?.trim() || DEFAULT_ENDPOINT,
  };
}

export function normalizeSearchArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("arguments must be an object");
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > 400) {
    throw new Error("query must be 1-400 characters");
  }

  const topic = args.topic ?? "general";
  if (!TOPICS.has(topic)) {
    throw new Error("topic must be general, news, or finance");
  }

  const searchDepth = args.search_depth ?? "basic";
  if (!DEPTHS.has(searchDepth)) {
    throw new Error("search_depth must be basic or advanced");
  }

  const includeAnswer = args.include_answer ?? true;
  if (typeof includeAnswer !== "boolean") {
    throw new Error("include_answer must be a boolean");
  }

  const maxResults = args.max_results ?? 5;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    throw new Error("max_results must be an integer from 1 to 10");
  }

  return {
    query,
    topic,
    search_depth: searchDepth,
    include_answer: includeAnswer,
    max_results: maxResults,
  };
}

function sourceResults(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((item) => ({
    title: typeof item?.title === "string" ? item.title : "",
    url: typeof item?.url === "string" ? item.url : "",
    content: typeof item?.content === "string" ? item.content : "",
    score: typeof item?.score === "number" ? item.score : null,
  }));
}

export function formatSearchResult(payload) {
  const answer = typeof payload?.answer === "string" ? payload.answer : "";
  const results = sourceResults(payload?.results);
  const lines = [];
  if (answer) {
    lines.push(answer, "");
  }
  if (results.length === 0) {
    lines.push("No source results.");
  } else {
    results.forEach((result, index) => {
      lines.push(`${index + 1}. ${result.title || result.url || "Untitled"}`);
      if (result.url) lines.push(result.url);
      if (result.content) lines.push(result.content);
      lines.push("");
    });
  }

  return {
    content: [{ type: "text", text: lines.join("\n").trim() }],
    structuredContent: {
      answer,
      results,
    },
    isError: false,
  };
}

export async function searchWeb(args, options = {}) {
  const request = normalizeSearchArgs(args);
  const config = options.config ?? searchConfig(options.env);
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
  });

  if (!response.ok) {
    const errorData = {
      status: response.status,
      response: await response.json()
    }
    throw new Error(`Tavily search failed (${JSON.stringify(errorData)})`);
  }

  return formatSearchResult(await response.json());
}
