export class SystemClock {
  now() {
    return Date.now();
  }
}

export class ManualClock {
  constructor(now = 0) {
    this.value = now;
  }

  now() {
    return this.value;
  }

  set(now) {
    this.value = now;
  }
}
