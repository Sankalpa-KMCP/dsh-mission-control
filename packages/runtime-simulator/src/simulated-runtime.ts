import { createHash } from 'node:crypto';
import {
  MissionControlError,
} from '../../contracts/src/index.ts';

import type {
  Activation,
  ActivationId,
  DelegationRequest,
  ModelRoute,
} from '../../contracts/src/index.ts';
import type { AgentRuntime, RuntimeExecutionResult } from '../../kernel/src/index.ts';
import { FaultInjector, type FaultConfig } from './fault-injection.ts';

export interface ActiveWorkerInstance {
  readonly activationId: ActivationId;
  readonly childAgentId: string;
  readonly taskId: string;
  state: 'starting' | 'active' | 'stopping' | 'terminated' | 'uncertain';
  readonly startedAt: number;
  abortController: AbortController;
}

export class SimulatedRuntime implements AgentRuntime {
  private readonly workers = new Map<ActivationId, ActiveWorkerInstance>();
  private readonly faultInjector: FaultInjector;
  private isRestarted: boolean = false;

  constructor(seed: number = 42, faultConfig: FaultConfig = {}) {
    this.faultInjector = new FaultInjector(seed, faultConfig);
  }

  public setFaultConfig(config: Partial<FaultConfig>): void {
    this.faultInjector.updateConfig(config);
  }

  public async startWorker(
    activation: Activation,
    request: DelegationRequest,
    _modelRoute: ModelRoute
  ): Promise<RuntimeExecutionResult> {
    const actId = activation.id;
    const abortController = new AbortController();

    const instance: ActiveWorkerInstance = {
      activationId: actId,
      childAgentId: activation.childAgentId,
      taskId: request.taskId,
      state: 'starting',
      startedAt: Date.now(),
      abortController,
    };

    this.workers.set(actId, instance);

    // 1. Fault Injection: Startup Failure
    if (this.faultInjector.shouldFailStartup(actId)) {
      instance.state = 'terminated';
      this.workers.delete(actId);
      throw new MissionControlError(`Simulated startup failure on worker ${actId}`, 'RUNTIME_STARTUP_FAILED');
    }

    // 2. Fault Injection: Startup Delay
    const delay = this.faultInjector.getStartupDelay();
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    instance.state = 'active';

    // 3. Fault Injection: Hang until Cancelled
    if (this.faultInjector.shouldHang()) {
      return new Promise((resolve) => {
        abortController.signal.addEventListener('abort', () => {
          instance.state = 'terminated';
          resolve({
            executionState: 'failed',
            exitCode: 130, // SIGINT
            failureReason: 'Execution cancelled while hanging',
          });
        });
      });
    }

    // 4. Fault Injection: Lost Acknowledgement
    // The worker actually completes, but the network reply is lost to the caller
    if (this.faultInjector.shouldLoseAcknowledgement(actId)) {
      instance.state = 'uncertain';
      throw new MissionControlError(
        `Simulated network partition: lost acknowledgement for ${actId}`,
        'LOST_ACKNOWLEDGEMENT'
      );
    }

    // 5. Fault Injection: Crash during Execution
    if (this.faultInjector.shouldCrash(actId)) {
      instance.state = 'terminated';
      const exitCode = this.faultInjector.getForcedExitCode() ?? 1;
      return {
        executionState: 'failed',
        exitCode,
        failureReason: `Simulated worker crash (exit code ${exitCode})`,
      };
    }

    // 6. Normal Deterministic Completion
    instance.state = 'terminated';
    const artifactSeed = `${request.taskId}:${activation.childAgentId}:${request.prompt}`;
    const artifactRevision = `art-rev-${createHash('sha256').update(artifactSeed).digest('hex').slice(0, 12)}`;

    return {
      executionState: 'completed',
      exitCode: 0,
      producedArtifactRevision: artifactRevision,
    };
  }

  public async cancelWorker(activationId: ActivationId): Promise<void> {
    const worker = this.workers.get(activationId);
    if (!worker) return;

    worker.state = 'stopping';
    worker.abortController.abort();
    worker.state = 'terminated';
  }

  public async pollWorker(
    activationId: ActivationId
  ): Promise<{ state: 'starting' | 'active' | 'terminated' | 'uncertain' }> {
    const worker = this.workers.get(activationId);
    if (!worker) {
      // If host was restarted and worker handle is lost, report terminated if not tracked
      return { state: 'terminated' };
    }
    return { state: worker.state };
  }

  /**
   * Simulate a host crash / restart:
   * Clears volatile runtime instances from memory, mimicking an abrupt process exit.
   */
  public restartRuntime(): void {
    this.workers.clear();
    this.isRestarted = true;
  }

  public getActiveWorkerCount(): number {
    let count = 0;
    for (const w of this.workers.values()) {
      if (w.state === 'starting' || w.state === 'active') {
        count++;
      }
    }
    return count;
  }
}
