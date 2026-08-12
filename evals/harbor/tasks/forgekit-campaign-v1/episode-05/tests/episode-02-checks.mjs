async function createPaidOrder(http, customerId, items, total) {
  const created = await http.request("POST", "/orders", { customerId, items });
  await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
  return created.json.id;
}

export function episode02Checks({ items, total }) {
  const partial = items[0].quantity * items[0].unitPriceCents;
  const rest = total - partial;
  return [
    {
      name: "partial_refund_on_paid",
      run: async (http) => {
        const id = await createPaidOrder(http, "cust-refund-partial", items, total);
        const refunded = await http.request("POST", `/orders/${id}/refunds`, { amountCents: partial });
        const got = await http.request("GET", `/orders/${id}`);
        return refunded.status === 200
          && refunded.json.amountCents === partial
          && refunded.json.orderId === id
          && typeof refunded.json.id === "string"
          && got.json.status === "paid"
          && got.json.chargedCents === total
          && got.json.refundedCents === partial;
      },
    },
    {
      name: "sequential_partial_refunds_accumulate",
      run: async (http) => {
        const id = await createPaidOrder(http, "cust-refund-seq", items, total);
        await http.request("POST", `/orders/${id}/refunds`, { amountCents: partial });
        const second = await http.request("POST", `/orders/${id}/refunds`, { amountCents: rest });
        const got = await http.request("GET", `/orders/${id}`);
        return second.status === 200
          && got.json.refundedCents === total
          && got.json.chargedCents === total;
      },
    },
    {
      name: "exact_remaining_refund_accepted",
      run: async (http) => {
        const id = await createPaidOrder(http, "cust-refund-exact", items, total);
        const refunded = await http.request("POST", `/orders/${id}/refunds`, { amountCents: total });
        const got = await http.request("GET", `/orders/${id}`);
        return refunded.status === 200 && got.json.refundedCents === total;
      },
    },
    {
      name: "over_refund_rejected_without_effect",
      run: async (http) => {
        const id = await createPaidOrder(http, "cust-refund-over", items, total);
        await http.request("POST", `/orders/${id}/refunds`, { amountCents: partial });
        const over = await http.request("POST", `/orders/${id}/refunds`, { amountCents: rest + 1 });
        const got = await http.request("GET", `/orders/${id}`);
        return over.status === 409
          && got.json.refundedCents === partial
          && got.json.chargedCents === total;
      },
    },
    {
      name: "refund_pending_rejected",
      run: async (http) => {
        const created = await http.request("POST", "/orders", { customerId: "cust-refund-pending", items });
        const refunded = await http.request("POST", `/orders/${created.json.id}/refunds`, { amountCents: partial });
        const got = await http.request("GET", `/orders/${created.json.id}`);
        return refunded.status === 409 && got.json.refundedCents === 0 && got.json.status === "pending";
      },
    },
    {
      name: "refund_cancelled_rejected_no_money",
      run: async (http) => {
        const created = await http.request("POST", "/orders", { customerId: "cust-refund-cancel", items });
        await http.request("POST", `/orders/${created.json.id}/charge`, { amountCents: total });
        await http.request("POST", `/orders/${created.json.id}/cancel`);
        const refunded = await http.request("POST", `/orders/${created.json.id}/refunds`, { amountCents: partial });
        const got = await http.request("GET", `/orders/${created.json.id}`);
        return refunded.status === 409
          && got.json.status === "cancelled"
          && got.json.refundedCents === 0;
      },
    },
    {
      name: "refund_on_shipped",
      run: async (http) => {
        const id = await createPaidOrder(http, "cust-refund-ship", items, total);
        await http.request("POST", `/orders/${id}/ship`);
        const refunded = await http.request("POST", `/orders/${id}/refunds`, { amountCents: partial });
        const got = await http.request("GET", `/orders/${id}`);
        return refunded.status === 200
          && got.json.status === "shipped"
          && got.json.refundedCents === partial;
      },
    },
  ];
}
