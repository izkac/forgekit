export class AppendOnlyEventStore {
  #events = [];
  #eventIds = new Set();

  append(event) {
    if (this.#eventIds.has(event.eventId)) return { appended: false, event: this.#events.find((entry) => entry.eventId === event.eventId) };
    const entry = Object.freeze({ ...event, storedAt: new Date().toISOString() });
    this.#eventIds.add(entry.eventId);
    this.#events.push(entry);
    return { appended: true, event: entry };
  }

  entries() {
    return this.#events.map((event) => ({ ...event }));
  }

  size() {
    return this.#events.length;
  }
}

export const InMemoryEventStore = AppendOnlyEventStore;
