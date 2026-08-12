export const sampleItems = [
  { sku: "SKU-RED", quantity: 2, unitPriceCents: 400 },
  { sku: "SKU-BLUE", quantity: 1, unitPriceCents: 200 },
];

export function sampleTotalCents() {
  return sampleItems.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
}

async function createOrder(http, customerId, items = sampleItems) {
  return http.request("POST", "/orders", { customerId, items });
}

function isOrder(json) {
  return json !== null && typeof json === "object" && typeof json.id === "string" && json.id.length > 0;
}

export function episode01Checks() {
  const total = sampleTotalCents();
  return [
    {
      name: "create_order_pending",
      run: async (http) => {
        const created = await createOrder(http, "cust-create");
        return created.status === 201
          && isOrder(created.json)
          && created.json.status === "pending"
          && created.json.totalCents === total
          && created.json.chargedCents === 0
          && created.json.refundedCents === 0
          && created.json.customerId === "cust-create"
          && created.json.createdAt === http.nowMs;
      },
    },
    {
      name: "get_order",
      run: async (http) => {
        const created = await createOrder(http, "cust-get");
        const got = await http.request("GET", `/orders/${created.json.id}`);
        return got.status === 200
          && got.json.id === created.json.id
          && got.json.status === "pending"
          && got.json.totalCents === total;
      },
    },
    {
      name: "get_missing_order",
      run: async (http) => {
        const got = await http.request("GET", "/orders/does-not-exist");
        return got.status === 404;
      },
    },
    {
      name: "charge_pending_to_paid",
      run: async (http) => {
        const created = await createOrder(http, "cust-charge");
        const charged = await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
        return charged.status === 200
          && charged.json.status === "paid"
          && charged.json.chargedCents === total
          && charged.json.refundedCents === 0;
      },
    },
    {
      name: "ship_paid_to_shipped",
      run: async (http) => {
        const created = await createOrder(http, "cust-ship");
        await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
        const shipped = await http.request("POST", `/orders/${created.json.id}/ship`);
        return shipped.status === 200 && shipped.json.status === "shipped";
      },
    },
    {
      name: "deliver_shipped_to_delivered",
      run: async (http) => {
        const created = await createOrder(http, "cust-deliver");
        await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
        await http.request("POST", `/orders/${created.json.id}/ship`);
        const delivered = await http.request("POST", `/orders/${created.json.id}/deliver`);
        return delivered.status === 200 && delivered.json.status === "delivered";
      },
    },
    {
      name: "cancel_pending",
      run: async (http) => {
        const created = await createOrder(http, "cust-cancel-pending");
        const cancelled = await http.request("POST", `/orders/${created.json.id}/cancel`);
        return cancelled.status === 200
          && cancelled.json.status === "cancelled"
          && cancelled.json.chargedCents === 0
          && cancelled.json.refundedCents === 0;
      },
    },
    {
      name: "cancel_paid_moves_no_money",
      run: async (http) => {
        const created = await createOrder(http, "cust-cancel-paid");
        await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
        const cancelled = await http.request("POST", `/orders/${created.json.id}/cancel`);
        return cancelled.status === 200
          && cancelled.json.status === "cancelled"
          && cancelled.json.chargedCents === total
          && cancelled.json.refundedCents === 0;
      },
    },
    {
      name: "cannot_charge_cancelled",
      run: async (http) => {
        const created = await createOrder(http, "cust-no-charge-cancel");
        await http.request("POST", `/orders/${created.json.id}/cancel`);
        const charged = await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
        const got = await http.request("GET", `/orders/${created.json.id}`);
        return charged.status === 409
          && got.json.status === "cancelled"
          && got.json.chargedCents === 0;
      },
    },
    {
      name: "cannot_ship_cancelled",
      run: async (http) => {
        const created = await createOrder(http, "cust-no-ship-cancel");
        await http.request("POST", `/orders/${created.json.id}/cancel`);
        const shipped = await http.request("POST", `/orders/${created.json.id}/ship`);
        return shipped.status === 409;
      },
    },
    {
      name: "cannot_deliver_cancelled",
      run: async (http) => {
        const created = await createOrder(http, "cust-no-deliver-cancel");
        await http.request("POST", `/orders/${created.json.id}/cancel`);
        const delivered = await http.request("POST", `/orders/${created.json.id}/deliver`);
        return delivered.status === 409;
      },
    },
    {
      name: "cancelled_is_terminal",
      run: async (http) => {
        const created = await createOrder(http, "cust-terminal");
        await http.request("POST", `/orders/${created.json.id}/cancel`);
        const again = await http.request("POST", `/orders/${created.json.id}/cancel`);
        const got = await http.request("GET", `/orders/${created.json.id}`);
        return again.status === 409 && got.json.status === "cancelled";
      },
    },
    {
      name: "cannot_ship_pending",
      run: async (http) => {
        const created = await createOrder(http, "cust-no-ship-pending");
        const shipped = await http.request("POST", `/orders/${created.json.id}/ship`);
        return shipped.status === 409;
      },
    },
    {
      name: "cannot_deliver_paid",
      run: async (http) => {
        const created = await createOrder(http, "cust-no-deliver-paid");
        await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
        const delivered = await http.request("POST", `/orders/${created.json.id}/deliver`);
        return delivered.status === 409;
      },
    },
    {
      name: "cannot_charge_already_paid",
      run: async (http) => {
        const created = await createOrder(http, "cust-double-charge");
        await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
        const again = await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
        const got = await http.request("GET", `/orders/${created.json.id}`);
        return again.status === 409 && got.json.chargedCents === total;
      },
    },
    {
      name: "wrong_charge_amount_moves_no_money",
      run: async (http) => {
        const created = await createOrder(http, "cust-wrong-amount");
        const charged = await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total - 1 });
        const got = await http.request("GET", `/orders/${created.json.id}`);
        return charged.status === 400
          && got.json.status === "pending"
          && got.json.chargedCents === 0;
      },
    },
    {
      name: "invalid_items_rejected",
      run: async (http) => {
        const created = await createOrder(http, "cust-bad-items", []);
        return created.status === 400;
      },
    },
    {
      name: "cancelled_refund_attempt_moves_no_money",
      run: async (http) => {
        const created = await createOrder(http, "cust-cancel-refund");
        await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
        await http.request("POST", `/orders/${created.json.id}/cancel`);
        const refunded = await http.request("POST", `/orders/${created.json.id}/refunds`, { amountCents: 100 });
        const got = await http.request("GET", `/orders/${created.json.id}`);
        return got.json.status === "cancelled"
          && got.json.chargedCents === total
          && got.json.refundedCents === 0
          && refunded.status !== 200;
      },
    },
  ];
}
