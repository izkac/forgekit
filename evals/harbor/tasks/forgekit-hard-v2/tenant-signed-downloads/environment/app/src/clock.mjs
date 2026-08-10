export class SystemClock {
  now() {
    return Date.now();
  }
}

export class ManualClock {
  constructor(currentTime) {
    this.currentTime = currentTime;
  }

  now() {
    return this.currentTime;
  }

  set(currentTime) {
    this.currentTime = currentTime;
  }
}
