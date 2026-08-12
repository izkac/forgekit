import http from "node:http";
import { OrderError, canTransition } from "./orders.mjs";
import { MemoryOrderStore } from "./store.mjs";
import { handleCreate, handleGet } from "./handlers/orders.mjs";
import { handleCancel, handleCharge, handleDeliver, handleShip } from "./handlers/transitions.mjs";
import { handleRefund } from "./handlers/refunds.mjs";

const replays = new Map();

function sendJson(response, status, value, scope = null) {
  if (scope) replays.set(scope, { status, body: value });
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OrderError("invalid_json", "Request body must be JSON", 400);
  }
}

function requireOrder(store, id) {
  const order = store.get(id);
  if (!order) throw new OrderError("not_found", "Order was not found", 404);
  return order;
}

function transition(order, next) {
  if (!canTransition(order.status, next)) {
    throw new OrderError("invalid_transition", `Cannot move from ${order.status} to ${next}`, 409);
  }
  order.status = next;
}

function replayScope(request, pathname) {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.trim() === "") return null;
  return `${request.method}:${pathname}:${value.trim()}`;
}

function replayIfPresent(request, pathname, response) {
  const scope = replayScope(request, pathname);
  if (!scope) return { handled: false, scope: null };
  const existing = replays.get(scope);
  if (existing) {
    sendJson(response, existing.status, existing.body);
    return { handled: true, scope };
  }
  return { handled: false, scope };
}

export function createApplication({ store = new MemoryOrderStore(), nowMs = () => Date.now() } = {}) {
  const server = http.createServer(async (request, response) => {
    let scope = null;
    try {
      const url = new URL(request.url, "http://orders.local");
      const parts = url.pathname.split("/").filter(Boolean);
      const ctx = { request, response, store, nowMs, sendJson, readJson, requireOrder, transition };

      if (request.method === "POST" && parts.length === 1 && parts[0] === "orders") {
        const replayed = replayIfPresent(request, url.pathname, response);
        if (replayed.handled) return;
        scope = replayed.scope;
        await handleCreate({ ...ctx, scope });
        return;
      }

      if (parts[0] !== "orders" || parts.length < 2) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const id = decodeURIComponent(parts[1]);
      const action = parts[2];

      if (request.method === "GET" && parts.length === 2) {
        handleGet({ ...ctx, id });
        return;
      }

      if (request.method === "POST" && action === "charge" && parts.length === 3) {
        const replayed = replayIfPresent(request, url.pathname, response);
        if (replayed.handled) return;
        scope = replayed.scope;
        await handleCharge({ ...ctx, id, scope });
        return;
      }

      if (request.method === "POST" && action === "ship" && parts.length === 3) {
        const replayed = replayIfPresent(request, url.pathname, response);
        if (replayed.handled) return;
        scope = replayed.scope;
        handleShip({ ...ctx, id, scope });
        return;
      }

      if (request.method === "POST" && action === "deliver" && parts.length === 3) {
        const replayed = replayIfPresent(request, url.pathname, response);
        if (replayed.handled) return;
        scope = replayed.scope;
        handleDeliver({ ...ctx, id, scope });
        return;
      }

      if (request.method === "POST" && action === "cancel" && parts.length === 3) {
        const replayed = replayIfPresent(request, url.pathname, response);
        if (replayed.handled) return;
        scope = replayed.scope;
        handleCancel({ ...ctx, id, scope });
        return;
      }

      if (request.method === "POST" && action === "refunds" && parts.length === 3) {
        const replayed = replayIfPresent(request, url.pathname, response);
        if (replayed.handled) return;
        scope = replayed.scope;
        await handleRefund({ ...ctx, id, scope });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof OrderError) {
        sendJson(response, error.status, { error: error.code, message: error.message }, scope);
      } else {
        sendJson(response, 500, { error: "internal_error" }, scope);
      }
    }
  });
  return { server, store };
}
