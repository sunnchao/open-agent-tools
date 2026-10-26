import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb } from "../../../platform/db.js";
import { createProvider, updateProvider } from "../../providers/store.js";
import { createWorkspace } from "../../../platform/workspace/store.js";
import { recordImChatAudit } from "../audit.js";
import { createChannel, deleteChannel } from "../channels/store.js";
import {
  archiveImChannelAccounts,
  initializeImAccounts,
  listImAccounts,
  recordImAccountInteraction,
  resolveImAccountModel,
  updateImAccount,
  updateImAccountExternalName,
} from "./store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-accounts-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.PROVIDER_KEYS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.PROVIDER_KEYS_ENCRYPTION_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("IM account store", () => {
  it("creates once per channel user and keeps the latest interaction", () => {
    const workspace = createWorkspace({ name: "Accounts" });
    const channel = createChannel({
      name: "Support",
      platform: "feishu",
      appId: "cli_support",
      workspaceId: workspace.id,
      enabled: false,
    });

    recordImAccountInteraction({
      channelId: channel.id,
      channelName: channel.name,
      platform: "feishu",
      workspaceId: workspace.id,
      externalUserId: "ou_alice",
      externalUserIdType: "feishu_open_id",
      externalName: "Alice",
      conversationId: "chat-1",
      chatType: "p2p",
      occurredAt: 100,
    });
    recordImAccountInteraction({
      channelId: channel.id,
      channelName: channel.name,
      platform: "feishu",
      workspaceId: workspace.id,
      externalUserId: "ou_alice",
      externalUserIdType: "feishu_open_id",
      externalName: null,
      conversationId: "chat-2",
      chatType: "group",
      occurredAt: 200,
    });

    const result = listImAccounts({ workspaceId: workspace.id });
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    assert.deepEqual(
      {
        channelName: result.items[0]?.channelName,
        externalName: result.items[0]?.externalName,
        firstInteractedAt: result.items[0]?.firstInteractedAt,
        lastInteractedAt: result.items[0]?.lastInteractedAt,
        lastConversationId: result.items[0]?.lastConversationId,
        lastChatType: result.items[0]?.lastChatType,
        channelDeleted: result.items[0]?.channelDeleted,
      },
      {
        channelName: "Support",
        externalName: "Alice",
        firstInteractedAt: 100,
        lastInteractedAt: 200,
        lastConversationId: "chat-2",
        lastChatType: "group",
        channelDeleted: false,
      },
    );
  });

  it("keeps the same external user separate across channels", () => {
    const workspace = createWorkspace({ name: "Multi channel" });
    const first = createChannel({
      name: "First",
      platform: "feishu",
      appId: "cli_first",
      workspaceId: workspace.id,
      enabled: false,
    });
    const second = createChannel({
      name: "Second",
      platform: "dingtalk",
      appId: "ding_second",
      workspaceId: workspace.id,
      enabled: false,
    });
    for (const channel of [first, second]) {
      recordImAccountInteraction({
        channelId: channel.id,
        channelName: channel.name,
        platform: channel.platform,
        workspaceId: workspace.id,
        externalUserId: "same-user",
        chatType: "p2p",
      });
    }

    assert.equal(listImAccounts({ workspaceId: workspace.id }).total, 2);
  });

  it("never overwrites a manual display name with an automatic external name", () => {
    const workspace = createWorkspace({ name: "Display name" });
    const channel = createChannel({
      name: "Support",
      platform: "feishu",
      appId: "cli_display",
      workspaceId: workspace.id,
      enabled: false,
    });
    recordImAccountInteraction({
      channelId: channel.id,
      channelName: channel.name,
      platform: "feishu",
      workspaceId: workspace.id,
      externalUserId: "ou_user",
      externalName: "Directory name",
      chatType: "p2p",
    });
    const account = listImAccounts({ workspaceId: workspace.id }).items[0]!;
    const updated = updateImAccount(account.id, workspace.id, {
      displayName: "VIP customer",
      remark: "Renewal owner",
    });
    assert.equal(updated?.displayName, "VIP customer");

    updateImAccountExternalName(channel.id, "ou_user", "New directory name");
    recordImAccountInteraction({
      channelId: channel.id,
      channelName: channel.name,
      platform: "feishu",
      workspaceId: workspace.id,
      externalUserId: "ou_user",
      externalName: "Newest directory name",
      chatType: "p2p",
      occurredAt: Date.now() + 1,
    });

    const current = listImAccounts({ workspaceId: workspace.id }).items[0]!;
    assert.equal(current.displayName, "VIP customer");
    assert.equal(current.externalName, "Newest directory name");
  });

  it("validates model bindings and falls back when the provider becomes unavailable", () => {
    const workspace = createWorkspace({ name: "Models" });
    const channel = createChannel({
      name: "Model bot",
      platform: "dingtalk",
      appId: "ding_model",
      workspaceId: workspace.id,
      enabled: false,
    });
    createProvider({
      id: "provider-account-test",
      name: "Account Provider",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-account-test",
      models: ["model-a", "model-b"],
    });
    recordImAccountInteraction({
      channelId: channel.id,
      channelName: channel.name,
      platform: "dingtalk",
      workspaceId: workspace.id,
      externalUserId: "staff-1",
      chatType: "p2p",
    });
    const account = listImAccounts({ workspaceId: workspace.id }).items[0]!;

    assert.throws(
      () =>
        updateImAccount(account.id, workspace.id, {
          providerId: "provider-account-test",
          model: "missing-model",
        }),
      /model is not available/,
    );
    const bound = updateImAccount(account.id, workspace.id, {
      providerId: "provider-account-test",
      model: "model-b",
    });
    assert.equal(bound?.bindingStatus, "valid");
    assert.deepEqual(resolveImAccountModel(channel.id, "staff-1"), {
      providerId: "provider-account-test",
      model: "model-b",
    });

    updateProvider("provider-account-test", { enabled: false });
    assert.equal(resolveImAccountModel(channel.id, "staff-1"), null);
    assert.equal(listImAccounts({ workspaceId: workspace.id }).items[0]?.bindingStatus, "invalid");

    const unbound = updateImAccount(account.id, workspace.id, {
      providerId: null,
      model: null,
    });
    assert.equal(unbound?.bindingStatus, "unbound");
  });

  it("backfills audit history once with the latest non-empty name", () => {
    recordImChatAudit({
      channelId: "deleted-channel",
      channelName: "Historical bot",
      platform: "feishu",
      workspace: "default",
      actor: "ou_history",
      actorName: "Old name",
      conversationId: "chat-old",
      chatType: "p2p",
      createdAt: 100,
    });
    recordImChatAudit({
      channelId: "deleted-channel",
      channelName: "Historical bot",
      platform: "feishu",
      workspace: "default",
      actor: "ou_history",
      actorName: "Latest name",
      conversationId: "chat-new",
      chatType: "group",
      createdAt: 200,
    });
    recordImChatAudit({
      channelId: "deleted-channel",
      channelName: "Historical bot",
      platform: "feishu",
      workspace: "default",
      actor: "ou_history",
      actorName: null,
      conversationId: "chat-latest",
      chatType: "group",
      createdAt: 300,
    });

    initializeImAccounts();
    initializeImAccounts();
    const result = listImAccounts({ workspaceId: "default" });
    assert.equal(result.total, 1);
    assert.deepEqual(
      {
        name: result.items[0]?.externalName,
        first: result.items[0]?.firstInteractedAt,
        last: result.items[0]?.lastInteractedAt,
        conversation: result.items[0]?.lastConversationId,
        chatType: result.items[0]?.lastChatType,
        deleted: result.items[0]?.channelDeleted,
      },
      {
        name: "Latest name",
        first: 100,
        last: 300,
        conversation: "chat-latest",
        chatType: "group",
        deleted: true,
      },
    );
  });

  it("retains an archived account after its channel is deleted", () => {
    const workspace = createWorkspace({ name: "Archive" });
    const channel = createChannel({
      name: "Before rename",
      platform: "feishu",
      appId: "cli_archive",
      workspaceId: workspace.id,
      enabled: false,
    });
    recordImAccountInteraction({
      channelId: channel.id,
      channelName: channel.name,
      platform: "feishu",
      workspaceId: workspace.id,
      externalUserId: "ou_archived",
      externalName: "Archived user",
      chatType: "p2p",
    });
    archiveImChannelAccounts(channel.id, {
      name: "Archived bot",
      platform: "feishu",
      workspaceId: workspace.id,
    });
    assert.equal(deleteChannel(channel.id), true);

    const account = listImAccounts({ workspaceId: workspace.id }).items[0]!;
    assert.equal(account.channelName, "Archived bot");
    assert.equal(account.channelDeleted, true);
    assert.ok(account.channelDeletedAt);

    // A late in-flight message must not resurrect an already deleted channel account.
    recordImAccountInteraction({
      channelId: channel.id,
      channelName: channel.name,
      platform: "feishu",
      workspaceId: workspace.id,
      externalUserId: "ou_archived",
      chatType: "p2p",
      occurredAt: account.lastInteractedAt + 1,
    });
    const afterLateMessage = listImAccounts({ workspaceId: workspace.id }).items[0]!;
    assert.equal(afterLateMessage.channelDeleted, true);
    assert.equal(afterLateMessage.channelName, "Archived bot");

    // Editing remains available after channel deletion.
    assert.equal(
      updateImAccount(account.id, workspace.id, { remark: "Retained history" })?.remark,
      "Retained history",
    );
  });
});
