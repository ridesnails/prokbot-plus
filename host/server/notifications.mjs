import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { JsonStore } from "./storage.mjs";
import { check } from "./security.mjs";

export class Notifications {
  constructor(dataDir, { retain = 1000, onPublish, replayLimit = 50, replayMaxBytes = 128 * 1024 } = {}) {
    this.store = new JsonStore(join(dataDir, "notifications.json"), {
      version: 1,
      items: [],
    });
    this.retain = retain;
    this.replayLimit = replayLimit;
    this.replayMaxBytes = replayMaxBytes;
    this.onPublish = onPublish;
    this.clients = new Set();
    this.pending = new Set();
  }
  async load() {
    await this.store.load();
    return this;
  }
  list(after) {
    const items = this.store.value.items;
    const index = after ? items.findIndex((item) => item.id === after) : -1;
    return items.slice(index + 1);
  }
  async publish(input) {
    check(
      ["message", "completed", "attention", "failed", "test"].includes(input.type),
      400,
      "不支持的通知类型",
    );
    check(
      typeof input.agentId === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(input.agentId),
      400,
      "会话 ID 无效",
    );
    check(
      typeof input.title === "string" &&
        input.title.trim().length > 0 &&
        input.title.length <= 160,
      400,
      "通知标题需要 1–160 个字符",
    );
    check(
      typeof input.body === "string" && input.body.length <= 2000,
      400,
      "通知正文过长",
    );
    const id = input.id ?? randomUUID();
    check(
      typeof id === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(id),
      400,
      "通知 ID 无效",
    );
    const item = {
      id,
      type: input.type,
      agentId: input.agentId,
      title: input.title.trim(),
      body: input.body,
      createdAt: new Date().toISOString(),
      deepLink: `grokbot-local://agent/${input.agentId}`,
    };
    const result = await this.store.mutate((state) => {
      const existing = state.items.find((value) => value.id === id);
      if (existing) return { item: existing, created: false };
      state.items.push(item);
      state.items = state.items.slice(-this.retain);
      return { item, created: true };
    });
    // The Host can retry an identical ID after an interrupted enqueue.
    await this.onPublish?.(result.item);
    if (result.created)
      for (const response of this.clients) this.send(response, result.item);
    return result;
  }
  format(item) {
    return `id: ${item.id}\nevent: notification\ndata: ${JSON.stringify(item)}\n\n`;
  }
  send(response, item) {
    if (response.destroyed || response.writableEnded) return;
    if (response.writableLength > 256 * 1024) return response.destroy();
    response.write(this.format(item));
  }
  replayItems(after) {
    const items = this.store.value.items;
    const hasCursor = Boolean(after) && items.some((item) => item.id === after);
    const pending = this.list(after);
    if (hasCursor) return pending;
    // Without a known Last-Event-ID, cap initial replay by count and bytes so
    // large retained histories do not overflow the SSE socket buffer on connect.
    const selected = [];
    let bytes = 0;
    for (let i = pending.length - 1; i >= 0 && selected.length < this.replayLimit; i--) {
      const chunkBytes = Buffer.byteLength(this.format(pending[i]));
      if (selected.length > 0 && bytes + chunkBytes > this.replayMaxBytes) break;
      selected.push(pending[i]);
      bytes += chunkBytes;
    }
    return selected.reverse();
  }
  subscribe(request, response) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    const queue = this.replayItems(request.headers["last-event-id"]);
    const queuedIds = new Set(queue.map((item) => item.id));
    let lastQueuedId = queue.at(-1)?.id ?? null;
    let closed = false;
    let index = 0;
    const heartbeat = setInterval(() => {
      if (closed || response.destroyed || response.writableEnded) return;
      if (response.writableLength > 256 * 1024) response.destroy();
      else response.write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref();
    this.pending.add(response);
    response.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      this.pending.delete(response);
      this.clients.delete(response);
    });
    const pump = () => {
      while (!closed && !response.destroyed && !response.writableEnded) {
        if (index >= queue.length) {
          const arrivals = lastQueuedId
            ? this.list(lastQueuedId).filter((item) => !queuedIds.has(item.id))
            : [];
          if (arrivals.length) {
            for (const item of arrivals) {
              queue.push(item);
              queuedIds.add(item.id);
              lastQueuedId = item.id;
            }
          } else {
            break;
          }
        }
        const ok = response.write(this.format(queue[index++]));
        if (!ok) {
          response.once("drain", pump);
          return;
        }
      }
      if (closed || response.destroyed || response.writableEnded) return;
      response.write(": connected\n\n");
      this.pending.delete(response);
      this.clients.add(response);
    };
    pump();
  }
  close() {
    for (const response of this.pending) response.destroy();
    for (const response of this.clients) response.destroy();
  }
}
