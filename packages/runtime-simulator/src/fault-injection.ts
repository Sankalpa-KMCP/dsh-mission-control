/**
 * Fault injection hooks and deterministic PRNG for DSH Mission Control simulator.
 */

export class DeterministicPrng {
  private state: number;

  constructor(seed: number = 1337) {
    this.state = seed >>> 0;
  }

  /**
   * Mulberry32 algorithm: returns a float in [0, 1).
   */
  public next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  public nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  public shouldHappen(probability: number): boolean {
    return this.next() < probability;
  }
}

export interface FaultConfig {
  readonly failStartupProbability?: number;
  readonly startupDelayMs?: number;
  readonly crashProbability?: number;
  readonly lostAcknowledgementProbability?: number;
  readonly hangUntilCancelled?: boolean;
  readonly forcedExitCode?: number;
  readonly targetIdMatch?: RegExp;
}

export class FaultInjector {
  private readonly prng: DeterministicPrng;
  private config: FaultConfig;

  constructor(seed: number = 42, config: FaultConfig = {}) {
    this.prng = new DeterministicPrng(seed);
    this.config = config;
  }

  public updateConfig(newConfig: Partial<FaultConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  public reset(seed: number = 42): void {
    this.config = {};
  }

  public shouldFailStartup(targetId: string): boolean {
    if (this.config.targetIdMatch && !this.config.targetIdMatch.test(targetId)) return false;
    return this.prng.shouldHappen(this.config.failStartupProbability ?? 0);
  }

  public shouldCrash(targetId: string): boolean {
    if (this.config.targetIdMatch && !this.config.targetIdMatch.test(targetId)) return false;
    return this.prng.shouldHappen(this.config.crashProbability ?? 0);
  }

  public shouldLoseAcknowledgement(targetId: string): boolean {
    if (this.config.targetIdMatch && !this.config.targetIdMatch.test(targetId)) return false;
    return this.prng.shouldHappen(this.config.lostAcknowledgementProbability ?? 0);
  }

  public getStartupDelay(): number {
    return this.config.startupDelayMs ?? 0;
  }

  public shouldHang(): boolean {
    return this.config.hangUntilCancelled ?? false;
  }

  public getForcedExitCode(): number | undefined {
    return this.config.forcedExitCode;
  }
}
