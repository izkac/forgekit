import { SystemClock } from "./clock.mjs";
import { ConfirmationService } from "./confirmation-service.mjs";
import { createHttpServer } from "./http-app.mjs";
import { MemoryPaymentGateway } from "./payment-gateway.mjs";
import { MemoryReservationStore } from "./reservation-store.mjs";

export function createApplication({
  clock = new SystemClock(),
  reservationStore = new MemoryReservationStore([{
    id: "demo-reservation",
    amount: 2500,
    expiresAt: clock.now() + 300_000
  }]),
  paymentGateway = new MemoryPaymentGateway()
} = {}) {
  const confirmationService = new ConfirmationService({ reservationStore, paymentGateway, clock });
  return {
    clock,
    reservationStore,
    paymentGateway,
    confirmationService,
    server: createHttpServer({ confirmationService, reservationStore })
  };
}
