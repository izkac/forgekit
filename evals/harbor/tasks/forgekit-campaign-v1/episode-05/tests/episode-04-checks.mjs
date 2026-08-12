function idempotencyHeaders(value) {
  return { "Idempotency-Key": value };
}

async function createOrder(http, customerId, items, key) {
  return http.request("POST", "/orders", { customerId, items }, key ? idempotencyHeaders(key) : {});
}

async function createPaid(http, customerId, items, total) {
  const created = await createOrder(http, customerId, items);
  await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
  return created.json.id;
}

export function episode04Checks({ items, total }) {
  const partial = items[0].quantity * items[0].unitPriceCents;
  return [
    {
      name: "create_replay_same_key_same_order",
      run: async (http) => {
        const headers = idempotencyHeaders("ep4-create-replay");
        const first = await http.request("POST", "/orders", { customerId: "cust-idemp-create", items }, headers);
        const second = await http.request("POST", "/orders", { customerId: "cust-idemp-create", items }, headers);
        return first.status === 201
          && second.status === 201
          && first.json.id === second.json.id
          && first.json.status === "pending";
      },
    },
    {
      name: "charge_replay_same_key_not_conflict",
      run: async (http) => {
        const created = await createOrder(http, "cust-idemp-charge", items);
        const headers = idempotencyHeaders("ep4-charge-replay");
        const first = await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total }, headers);
        const second = await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total }, headers);
        const got = await http.request("GET", `/orders/${created.json.id}`);
        return first.status === 200
          && second.status === 200
          && second.json.status === "paid"
          && got.json.chargedCents === total;
      },
    },
    {
      name: "ship_replay_same_key_not_conflict",
      run: async (http) => {
        const id = await createPaid(http, "cust-idemp-ship", items, total);
        const headers = idempotencyHeaders("ep4-ship-replay");
        const first = await http.request("POST", `/orders/${id}/ship`, undefined, headers);
        const second = await http.request("POST", `/orders/${id}/ship`, undefined, headers);
        return first.status === 200 && second.status === 200 && second.json.status === "shipped";
      },
    },
    {
      name: "deliver_replay_same_key_not_conflict",
      run: async (http) => {
        const id = await createPaid(http, "cust-idemp-deliver", items, total);
        await http.request("POST", `/orders/${id}/ship`);
        const headers = idempotencyHeaders("ep4-deliver-replay");
        const first = await http.request("POST", `/orders/${id}/deliver`, undefined, headers);
        const second = await http.request("POST", `/orders/${id}/deliver`, undefined, headers);
        return first.status === 200 && second.status === 200 && second.json.status === "delivered";
      },
    },
    {
      name: "cancel_replay_same_key_not_conflict",
      run: async (http) => {
        const created = await createOrder(http, "cust-idemp-cancel", items);
        const headers = idempotencyHeaders("ep4-cancel-replay");
        const first = await http.request("POST", `/orders/${created.json.id}/cancel`, undefined, headers);
        const second = await http.request("POST", `/orders/${created.json.id}/cancel`, undefined, headers);
        const got = await http.request("GET", `/orders/${created.json.id}`);
        return first.status === 200
          && second.status === 200
          && got.json.status === "cancelled"
          && got.json.chargedCents === 0;
      },
    },
    {
      name: "refund_replay_same_key_no_double_money",
      run: async (http) => {
        const id = await createPaid(http, "cust-idemp-refund", items, total);
        const headers = idempotencyHeaders("ep4-refund-replay");
        const first = await http.request("POST", `/orders/${id}/refunds`, { amountCents: partial }, headers);
        const second = await http.request("POST", `/orders/${id}/refunds`, { amountCents: partial }, headers);
        const got = await http.request("GET", `/orders/${id}`);
        return first.status === 200
          && second.status === 200
          && first.json.id === second.json.id
          && first.json.amountCents === partial
          && got.json.refundedCents === partial
          && got.json.chargedCents === total;
      },
    },
    {
      name: "distinct_keys_create_distinct_orders",
      run: async (http) => {
        const first = await createOrder(http, "cust-idemp-distinct", items, "ep4-create-a");
        const second = await createOrder(http, "cust-idemp-distinct", items, "ep4-create-b");
        return first.status === 201
          && second.status === 201
          && first.json.id !== second.json.id;
      },
    },
  ];
}
