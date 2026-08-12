import { FIXED_NOW_MS, startAppServer } from "./http-runtime.mjs";

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_NOW_MS = FIXED_NOW_MS - THIRTY_DAYS_MS - 86_400_000;

async function withRestartedClock(appDirectory, seed, inspect) {
  const old = await startAppServer(appDirectory, { nowMs: STALE_NOW_MS });
  let id;
  try {
    id = await seed(old);
  } finally {
    old.stop();
  }
  const current = await startAppServer(appDirectory, { nowMs: FIXED_NOW_MS });
  try {
    return await inspect(current, id);
  } finally {
    current.stop();
  }
}

async function createPaid(http, customerId, items, total) {
  const created = await http.request("POST", "/orders", { customerId, items });
  await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
  return created.json.id;
}

export function episode06Checks({ items, total, appDirectory }) {
  return [
    {
      name: "stale_pending_expires",
      run: async () => withRestartedClock(
        appDirectory,
        async (http) => {
          const created = await http.request("POST", "/orders", { customerId: "cust-expire-pending", items });
          return created.json.id;
        },
        async (http, id) => {
          const got = await http.request("GET", `/orders/${id}`);
          return got.status === 200 && got.json.status === "expired";
        },
      ),
    },
    {
      name: "stale_paid_stays_paid",
      run: async () => withRestartedClock(
        appDirectory,
        async (http) => createPaid(http, "cust-expire-paid", items, total),
        async (http, id) => {
          const got = await http.request("GET", `/orders/${id}`);
          return got.status === 200
            && got.json.status === "paid"
            && got.json.chargedCents === total;
        },
      ),
    },
    {
      name: "stale_shipped_stays_shipped",
      run: async () => withRestartedClock(
        appDirectory,
        async (http) => {
          const id = await createPaid(http, "cust-expire-ship", items, total);
          await http.request("POST", `/orders/${id}/ship`);
          return id;
        },
        async (http, id) => {
          const got = await http.request("GET", `/orders/${id}`);
          return got.status === 200 && got.json.status === "shipped";
        },
      ),
    },
    {
      name: "stale_delivered_stays_delivered",
      run: async () => withRestartedClock(
        appDirectory,
        async (http) => {
          const id = await createPaid(http, "cust-expire-deliver", items, total);
          await http.request("POST", `/orders/${id}/ship`);
          await http.request("POST", `/orders/${id}/deliver`);
          return id;
        },
        async (http, id) => {
          const got = await http.request("GET", `/orders/${id}`);
          return got.status === 200 && got.json.status === "delivered";
        },
      ),
    },
    {
      name: "stale_cancelled_stays_cancelled",
      run: async () => withRestartedClock(
        appDirectory,
        async (http) => {
          const id = await createPaid(http, "cust-expire-cancel", items, total);
          await http.request("POST", `/orders/${id}/cancel`);
          return id;
        },
        async (http, id) => {
          const got = await http.request("GET", `/orders/${id}`);
          return got.status === 200
            && got.json.status === "cancelled"
            && got.json.chargedCents === total
            && got.json.refundedCents === 0;
        },
      ),
    },
    {
      name: "fresh_pending_does_not_expire",
      run: async () => {
        const http = await startAppServer(appDirectory, { nowMs: FIXED_NOW_MS });
        try {
          const created = await http.request("POST", "/orders", { customerId: "cust-expire-fresh", items });
          const got = await http.request("GET", `/orders/${created.json.id}`);
          return created.status === 201
            && got.status === 200
            && got.json.status === "pending";
        } finally {
          http.stop();
        }
      },
    },
  ];
}
