import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import {
  executeWorkflow,
  executeWorkflowNodeTest,
  type WorkflowEvent,
  type WorkflowNodeInput,
} from "./executor.js";
import { buildHttpRequest, httpResponseLimit, runHttp } from "./http.js";

let server: Server;
let origin: string;
let retryCalls = 0;
let lastRequest: { method?: string; authorization?: string; custom?: string } = {};
let abortedResponses = 0;
before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    lastRequest = {
      method: request.method,
      authorization: request.headers.authorization,
      custom: request.headers["x-demo"] as string | undefined,
    };
    if (url.pathname === "/retry" && ++retryCalls === 1) {
      response.writeHead(500).end("first failure");
      return;
    }
    if (url.pathname === "/client-error") {
      response.writeHead(401).end("not authorized");
      return;
    }
    if (url.pathname === "/slow") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"slow":');
      const timer = setTimeout(() => response.end("true}"), 3500);
      response.once("close", () => {
        clearTimeout(timer);
        if (!response.writableEnded) abortedResponses++;
      });
      return;
    }
    if (url.pathname === "/text") {
      response.writeHead(200, { "content-type": "text/plain" }).end("中文 response");
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      authorization: request.headers.authorization ?? "none",
    });
    const raw = Buffer.concat(chunks).toString();
    response.end(
      JSON.stringify({
        method: request.method,
        args: Object.fromEntries(url.searchParams),
        headers: request.headers,
        json:
          request.headers["content-type"]?.startsWith("application/json") && raw
            ? JSON.parse(raw)
            : null,
        raw,
        items: [{ id: "first-item" }],
      }),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
});
const httpNode = (config: Record<string, unknown> = {}): WorkflowNodeInput => ({
  id: "http",
  kind: "http",
  config: {
    url: `${origin}/echo`,
    inputs: [],
    outputs: [
      { name: "body", selector: "$result.body" },
      { name: "status_code", selector: "$result.status_code" },
      { name: "headers", selector: "$result.headers" },
      { name: "size", selector: "$result.size" },
    ],
    ...config,
  },
});

it("performs real GET requests with safely encoded query values and nested selectors", async () => {
  const result = await executeWorkflowNodeTest({
    node: httpNode({
      params: "q:{{q}}",
      inputs: [{ name: "q", source: { type: "literal", value: "a&b:中文" } }],
      outputs: [
        { name: "id", selector: "$result.body.items[0].id" },
        { name: "body", selector: "$result.body" },
      ],
    }),
    inputs: {},
  });
  assert.equal(result.status, "success");
  assert.equal(result.outputs.id, "first-item");
  assert.equal((result.outputs.body as { args: { q: string } }).args.q, "a&b:中文");
  assert.equal(result.metadata.tokenUsage.totalTokens, 0);
  assert.equal(
    buildHttpRequest(
      { url: `${origin}/echo?existing=yes`, params: "q:first&q:{{q}}" },
      { q: "a&b" },
    )
      .url.searchParams.getAll("q")
      .join(),
    "first,a&b",
  );
});

it("sends typed JSON, raw text and multipart form bodies for all modifying methods", async () => {
  for (const method of ["post", "put", "patch", "delete"]) {
    const result = await executeWorkflowNodeTest({
      node: httpNode({
        method,
        body: { type: "json", data: '{"count":"{{count}}","flag":"{{flag}}"}' },
        inputs: [
          { name: "count", source: { type: "literal", value: 2 } },
          { name: "flag", source: { type: "literal", value: false } },
        ],
      }),
      inputs: {},
    });
    assert.equal(result.status, "success");
    assert.deepEqual((result.result as { body: { json: unknown } }).body.json, {
      count: 2,
      flag: false,
    });
    assert.equal(lastRequest.method, method.toUpperCase());
  }
  const raw = await executeWorkflowNodeTest({
    node: httpNode({ method: "post", body: { type: "raw", data: "raw body" } }),
    inputs: {},
  });
  assert.equal((raw.result as { body: { raw: string } }).body.raw, "raw body");
  const form = await executeWorkflowNodeTest({
    node: httpNode({
      method: "post",
      body: { type: "form-data", data: [{ key: "title", type: "text", value: "form value" }] },
    }),
    inputs: {},
  });
  const body = (form.result as { body: { raw: string; headers: Record<string, string> } }).body;
  assert.match(body.headers["content-type"]!, /^multipart\/form-data; boundary=/);
  assert.match(body.raw, /name="title"/);
  assert.match(body.raw, /form value/);
});

it("handles HEAD and text responses and measures UTF-8 byte size", async () => {
  const head = await executeWorkflowNodeTest({ node: httpNode({ method: "head" }), inputs: {} });
  assert.equal(head.status, "success");
  assert.equal((head.result as { size: number }).size, 0);
  const text = await executeWorkflowNodeTest({
    node: httpNode({ url: `${origin}/text` }),
    inputs: {},
  });
  assert.equal((text.result as { body: string }).body, "中文 response");
  assert.equal((text.result as { size: number }).size, Buffer.byteLength("中文 response"));
});

it("sends real Bearer, Basic and custom authentication while redacting echo responses and traces even in DEBUG", async () => {
  const previousDebug = process.env.DEBUG;
  process.env.DEBUG = "true";
  const logs: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...values) => {
    logs.push(values);
  };
  try {
    for (const auth of [
      { type: "bearer", config: { token: "private-bearer-credential" } },
      { type: "basic", config: { username: "user", password: "private-basic-password" } },
      { type: "custom", config: { header: "X-Demo", value: "private-custom-value" } },
    ]) {
      const result = await executeWorkflowNodeTest({
        node: httpNode({ authorization: auth }),
        inputs: {},
      });
      assert.equal(result.status, "success");
      if (auth.type === "bearer")
        assert.equal(lastRequest.authorization, "Bearer private-bearer-credential");
      if (auth.type === "basic")
        assert.equal(
          lastRequest.authorization,
          `Basic ${Buffer.from("user:private-basic-password").toString("base64")}`,
        );
      if (auth.type === "custom") assert.equal(lastRequest.custom, "private-custom-value");
      const serialized = JSON.stringify(result);
      for (const secret of [
        "private-bearer-credential",
        "private-basic-password",
        "private-custom-value",
        Buffer.from("user:private-basic-password").toString("base64"),
      ])
        assert.equal(serialized.includes(secret), false);
    }
    const events: WorkflowEvent[] = [];
    await executeWorkflow(
      {
        nodes: [httpNode({ authorization: { type: "bearer", config: { token: "success" } } })],
        edges: [],
        input: {},
      },
      (event) => events.push(event),
    );
    assert.equal(events.find((event) => event.type === "node_result")?.status, "success");
    assert.equal(JSON.stringify(logs).includes("private-"), false);
  } finally {
    console.log = originalLog;
    if (previousDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = previousDebug;
  }
});

it("retries real HTTP 500 responses and does not retry HTTP 401", async () => {
  retryCalls = 0;
  const result = await executeWorkflowNodeTest({
    node: httpNode({ url: `${origin}/retry`, retry: { maxRetries: 1, delayMs: 100 } }),
    inputs: {},
  });
  assert.equal(result.status, "success");
  assert.equal(retryCalls, 2);
  assert.equal(result.metadata.attempts, 2);
  const rejected = await executeWorkflowNodeTest({
    node: httpNode({ url: `${origin}/client-error`, retry: { maxRetries: 3, delayMs: 100 } }),
    inputs: {},
  });
  assert.equal(rejected.status, "error");
  assert.equal(rejected.metadata.attempts, 1);
});

it("times out the entire response read and aborts the real socket", async () => {
  const result = await executeWorkflowNodeTest({
    node: httpNode({ url: `${origin}/slow`, timeoutMs: 1000 }),
    inputs: {},
  });
  assert.equal(result.status, "error");
  assert.match(result.error!, /1000ms/);
  for (let attempt = 0; attempt < 20 && !abortedResponses; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(abortedResponses > 0);
});

it("rejects invalid URL schemes, credential URLs, transport headers and host allowlist bypasses", async () => {
  assert.throws(() => buildHttpRequest({ url: "file:///tmp/private" }, {}), /HTTP\/HTTPS/);
  assert.throws(
    () => buildHttpRequest({ url: "https://user:password@example.com" }, {}),
    /credentials/,
  );
  assert.throws(
    () => buildHttpRequest({ url: origin, headers: "Host: other" }, {}),
    /transport header/,
  );
  assert.throws(
    () =>
      buildHttpRequest(
        {
          url: origin,
          authorization: { type: "custom", config: { header: "Host", value: "other" } },
        },
        {},
      ),
    /transport headers/,
  );
  const old = process.env.WORKFLOW_HTTP_ALLOWLIST;
  try {
    process.env.WORKFLOW_HTTP_ALLOWLIST = "example.com";
    assert.throws(
      () => buildHttpRequest({ url: "https://example.com.evil.test" }, {}),
      /ALLOWLIST/,
    );
    assert.equal(
      buildHttpRequest({ url: "https://example.com/allowed" }, {}).url.hostname,
      "example.com",
    );
  } finally {
    if (old === undefined) delete process.env.WORKFLOW_HTTP_ALLOWLIST;
    else process.env.WORKFLOW_HTTP_ALLOWLIST = old;
  }
});

it("rejects oversized responses before retaining them", async () => {
  const result = await executeWorkflowNodeTest(
    { node: httpNode(), inputs: {} },
    {
      fetchFn: async () =>
        new Response("large", { headers: { "content-length": String(httpResponseLimit + 1) } }),
    },
  );
  assert.equal(result.status, "error");
  assert.match(result.error!, /5 MB/);
});

it("strips resolved custom credentials on cross-origin redirects and checks each redirected hostname", async () => {
  const requests: RequestInit[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    requests.push(init!);
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://other.example/echo" } })
      : new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
  };
  await runHttp(
    {
      url: "https://first.example",
      authorization: { type: "custom", config: { header: "{{header}}", value: "private-custom" } },
      headers: "Authorization:Bearer private-token\nAccept:application/json",
    },
    { header: "X-Demo" },
    undefined,
    async (url, init) => {
      const snapshot = { ...init, headers: new Headers(init?.headers) };
      return fetchFn(url, snapshot);
    },
  );
  const initial = new Headers(requests[0]!.headers);
  const redirected = new Headers(requests[1]!.headers);
  assert.equal(initial.get("x-demo"), "private-custom");
  assert.equal(redirected.get("x-demo"), null);
  assert.equal(redirected.get("authorization"), null);
  assert.equal(redirected.get("accept"), "application/json");
  const old = process.env.WORKFLOW_HTTP_ALLOWLIST;
  try {
    process.env.WORKFLOW_HTTP_ALLOWLIST = "first.example";
    await assert.rejects(
      runHttp(
        { url: "https://first.example" },
        {},
        undefined,
        async () =>
          new Response(null, { status: 302, headers: { location: "https://other.example" } }),
      ),
      /ALLOWLIST/,
    );
  } finally {
    if (old === undefined) delete process.env.WORKFLOW_HTTP_ALLOWLIST;
    else process.env.WORKFLOW_HTTP_ALLOWLIST = old;
  }
});

it("keeps TLS verification enabled by default and scopes opt-out to one self-signed request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-http-tls-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const tls = createHttpsServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (_req, response) => response.end("tls verified"),
  );
  tls.listen(0, "127.0.0.1");
  await once(tls, "listening");
  const address = tls.address();
  assert.ok(address && typeof address === "object");
  try {
    const url = `https://127.0.0.1:${address.port}`;
    const strict = await executeWorkflowNodeTest({ node: httpNode({ url }), inputs: {} });
    assert.equal(strict.status, "error");
    const relaxed = await executeWorkflowNodeTest({
      node: httpNode({ url, sslVerify: false }),
      inputs: {},
    });
    assert.equal(relaxed.status, "success");
    assert.equal((relaxed.result as { body: string }).body, "tls verified");
    const strictAgain = await executeWorkflowNodeTest({ node: httpNode({ url }), inputs: {} });
    assert.equal(strictAgain.status, "error");
  } finally {
    tls.closeAllConnections();
    tls.close();
    await once(tls, "close");
    rmSync(dir, { recursive: true, force: true });
  }
});
