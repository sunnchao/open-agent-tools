import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../../app.js";
import { closeDb } from "../../../platform/db.js";
import {
  recordImAccountInteraction,
  resolveImAccountModel,
  updateImAccountExternalName,
} from "./store.js";
import { answerImMessage } from "../answerMessage.js";
import type { ChatAnswer } from "../chatClient.js";
import { createChannel, getChannel } from "../channels/store.js";
import type { ImChannelAccount } from "./store.js";
import { createProvider } from "../../providers/store.js";
import { createWorkspace } from "../../../platform/workspace/store.js";

let server: Server;
let origin: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "im-accounts-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.PROVIDER_KEYS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.STUDIO_API_TOKEN;
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.PROVIDER_KEYS_ENCRYPTION_KEY;
  rmSync(dir, { recursive: true, force: true });
});

const answer: ChatAnswer = {
  content: "ok",
  toolCalls: [],
  toolResultCount: 0,
  citations: 0,
};

describe("IM accounts API", () => {
  it("creates from conversation, applies model binding and survives channel deletion", async () => {
    const workspace = createWorkspace({ name: "IM account acceptance" });
    const otherWorkspace = createWorkspace({ name: "Other IM account space" });
    createProvider({
      id: "account-provider",
      name: "Bound Provider",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-bound-provider",
      models: ["bound-model"],
    });
    const headers = {
      "content-type": "application/json",
      "x-workspace-id": workspace.id,
    };

    const createdResponse = await fetch(`${origin}/api/admin/im/channels`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Customer bot",
        platform: "feishu",
        appId: "cli_customer",
        enabled: false,
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as {
      channel: { id: string; workspaceId: string };
    };
    assert.equal(created.channel.workspaceId, workspace.id);
    const channelId = created.channel.id;

    const config = {
      name: "Customer bot",
      channelId,
      platform: "feishu" as const,
      appId: "cli_customer",
      appSecret: "",
      ragSources: [],
      ragTopK: 5,
      sqlSources: [],
      mcpTools: [],
      requireMention: true,
      chatBaseUrl: origin,
      workspaceId: workspace.id,
    };
    const baseEvent = {
      platform: "feishu" as const,
      messageId: "message-1",
      chatId: "chat-1",
      chatType: "p2p" as const,
      senderOpenId: "ou_customer",
      senderIdType: "feishu_open_id" as const,
      senderName: "Alice",
      text: "hello",
      mentioned: false,
    };
    const accountDeps = {
      recordAccountInteraction: recordImAccountInteraction,
      updateAccountExternalName: updateImAccountExternalName,
      resolveAccountModel: resolveImAccountModel,
      reply: async () => {},
      recordAudit: () => null,
    };

    await answerImMessage(config, baseEvent, {
      ...accountDeps,
      askChat: async (request) => {
        assert.equal("providerId" in request, false);
        return answer;
      },
    });
    await answerImMessage(
      config,
      {
        ...baseEvent,
        messageId: "message-2",
        chatId: "chat-2",
        senderName: "Alice updated",
      },
      {
        ...accountDeps,
        askChat: async () => answer,
      },
    );

    const listedResponse = await fetch(`${origin}/api/admin/im/accounts`, { headers });
    assert.equal(listedResponse.status, 200);
    const listed = (await listedResponse.json()) as {
      items: ImChannelAccount[];
      total: number;
    };
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0]?.externalName, "Alice updated");
    assert.equal(listed.items[0]?.lastConversationId, "chat-2");
    const accountId = listed.items[0]!.id;

    const patchedResponse = await fetch(
      `${origin}/api/admin/im/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          displayName: "VIP Alice",
          remark: "Priority customer",
          providerId: "account-provider",
          model: "bound-model",
        }),
      },
    );
    assert.equal(patchedResponse.status, 200);
    const patched = (await patchedResponse.json()) as { account: ImChannelAccount };
    assert.equal(patched.account.displayName, "VIP Alice");
    assert.equal(patched.account.bindingStatus, "valid");

    await answerImMessage(
      config,
      {
        ...baseEvent,
        messageId: "message-3",
        chatId: "chat-3",
      },
      {
        ...accountDeps,
        askChat: async (request) => {
          assert.equal(request.providerId, "account-provider");
          assert.equal(request.model, "bound-model");
          return answer;
        },
      },
    );

    const otherList = await fetch(`${origin}/api/admin/im/accounts`, {
      headers: { "x-workspace-id": otherWorkspace.id },
    });
    assert.equal(((await otherList.json()) as { total: number }).total, 0);
    const crossedPatch = await fetch(
      `${origin}/api/admin/im/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": otherWorkspace.id,
        },
        body: JSON.stringify({ remark: "should not cross" }),
      },
    );
    assert.equal(crossedPatch.status, 404);

    const crossedDelete = await fetch(
      `${origin}/api/admin/im/channels/${encodeURIComponent(channelId)}`,
      {
        method: "DELETE",
        headers: { "x-workspace-id": otherWorkspace.id },
      },
    );
    assert.equal(crossedDelete.status, 404);
    assert.ok(getChannel(channelId, { includeDisabled: true }));

    const deletedResponse = await fetch(
      `${origin}/api/admin/im/channels/${encodeURIComponent(channelId)}`,
      {
        method: "DELETE",
        headers: { "x-workspace-id": workspace.id },
      },
    );
    assert.equal(deletedResponse.status, 204);
    assert.equal(getChannel(channelId, { includeDisabled: true }), null);

    const retainedResponse = await fetch(`${origin}/api/admin/im/accounts?channelState=deleted`, {
      headers,
    });
    assert.equal(retainedResponse.status, 200);
    const retained = (await retainedResponse.json()) as {
      items: ImChannelAccount[];
      total: number;
    };
    assert.equal(retained.total, 1);
    assert.equal(retained.items[0]?.channelName, "Customer bot");
    assert.equal(retained.items[0]?.channelDeleted, true);

    const retainedPatch = await fetch(
      `${origin}/api/admin/im/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ remark: "History remains editable" }),
      },
    );
    assert.equal(retainedPatch.status, 200);
    assert.equal(
      ((await retainedPatch.json()) as { account: ImChannelAccount }).account.remark,
      "History remains editable",
    );

    const unsupportedPlatform = await fetch(`${origin}/api/admin/im/accounts?platform=wechat`, {
      headers,
    });
    assert.equal(unsupportedPlatform.status, 400);
    const deleteAccount = await fetch(
      `${origin}/api/admin/im/accounts/${encodeURIComponent(accountId)}`,
      { method: "DELETE", headers },
    );
    assert.equal(deleteAccount.status, 404);
  });

  it("scopes IM channel lists and edits to the current workspace", async () => {
    const workspace = createWorkspace({ name: "Channel scope A" });
    const other = createWorkspace({ name: "Channel scope B" });
    const ownChannel = createChannel({
      name: "Workspace A channel",
      platform: "feishu",
      appId: "cli_scope_a",
      workspaceId: workspace.id,
      enabled: false,
    });
    const otherChannel = createChannel({
      name: "Workspace B channel",
      platform: "feishu",
      appId: "cli_scope_b",
      workspaceId: other.id,
      enabled: false,
    });

    const response = await fetch(`${origin}/api/admin/im/channels`, {
      headers: { "x-workspace-id": workspace.id },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { channels: Array<{ id: string }> };
    assert.deepEqual(
      body.channels.map((channel) => channel.id),
      [ownChannel.id],
    );

    const crossedUpdate = await fetch(
      `${origin}/api/admin/im/channels/${encodeURIComponent(otherChannel.id)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": workspace.id,
        },
        body: JSON.stringify({ name: "Should fail" }),
      },
    );
    assert.equal(crossedUpdate.status, 404);
  });
});
