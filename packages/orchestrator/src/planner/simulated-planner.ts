/**
 * Deterministic simulated mission planner.
 *
 * Decomposes a mission into a fixed autonomous software-engineering workflow:
 * intake analysis, technical design, three parallel implementation tracks with
 * disjoint write scopes, test implementation, independent review, integration,
 * and documentation. The plan is a DAG: the scheduler enforces dependency
 * ordering and the verification gate requires an independent pass per task.
 *
 * Every artifact of this planner is SIMULATED: it is a realistic template
 * decomposition, not a model-generated plan. It exists so the platform is
 * fully usable before a real chief-model planning backend is connected.
 */

import type { Mission, MissionPlanner, MissionPlan, PlannedTaskSpec } from '../types.ts';

export class SimulatedMissionPlanner implements MissionPlanner {
  public readonly name = 'simulated-template-planner';

  public plan(mission: Mission): MissionPlan {
    const tasks: PlannedTaskSpec[] = [
      {
        key: 'intake',
        title: 'Analyze objective and produce execution plan',
        description:
          `Break down the mission objective "${mission.title}" into concrete engineering work. ` +
          'Identify constraints, risks, and required deliverables. Produce a structured analysis document.',
        acceptanceCriteria:
          'Analysis document exists and enumerates deliverables, constraints, and risks for the mission.',
        priority: 'critical',
        blockedByKeys: [],
        writeScopes: ['plan/'],
      },
      {
        key: 'design',
        title: 'Produce technical design and interface contracts',
        description:
          'Define the technical approach, module boundaries, and interface contracts for the mission. ' +
          'Document architectural decisions and their rationale.',
        acceptanceCriteria:
          'Design document exists with module boundaries, interface contracts, and recorded decisions.',
        priority: 'high',
        blockedByKeys: ['intake'],
        writeScopes: ['design/'],
      },
      {
        key: 'impl-core',
        title: 'Implement core modules',
        description: 'Implement the core functional modules defined by the design. Keep changes scoped to the core write scope.',
        acceptanceCriteria: 'Core modules build cleanly and expose the interfaces defined in the design document.',
        priority: 'high',
        blockedByKeys: ['design'],
        writeScopes: ['src/core/'],
      },
      {
        key: 'impl-interfaces',
        title: 'Implement integration interfaces',
        description: 'Implement the integration and boundary interfaces defined by the design. Keep changes scoped to the interface write scope.',
        acceptanceCriteria: 'Integration interfaces build cleanly and conform to the design contracts.',
        priority: 'normal',
        blockedByKeys: ['design'],
        writeScopes: ['src/interfaces/'],
      },
      {
        key: 'impl-tooling',
        title: 'Implement supporting tooling',
        description: 'Implement developer and operational tooling required by the mission. Keep changes scoped to the tooling write scope.',
        acceptanceCriteria: 'Tooling runs successfully against the core modules without errors.',
        priority: 'normal',
        blockedByKeys: ['design'],
        writeScopes: ['tools/'],
      },
      {
        key: 'tests',
        title: 'Implement and run test suites',
        description: 'Implement unit and integration test suites covering the implemented functionality and execute them.',
        acceptanceCriteria: 'All test suites execute with zero failing assertions and cover the delivered functionality.',
        priority: 'high',
        blockedByKeys: ['impl-core', 'impl-interfaces', 'impl-tooling'],
        writeScopes: ['tests/'],
      },
      {
        key: 'review',
        title: 'Independent review and security pass',
        description: 'Perform an independent review of the implementation for correctness, concurrency defects, and security issues.',
        acceptanceCriteria: 'Review report exists with findings classified by severity and no unaddressed critical findings.',
        priority: 'high',
        blockedByKeys: ['impl-core', 'impl-interfaces', 'impl-tooling'],
        writeScopes: ['review/'],
      },
      {
        key: 'integration',
        title: 'Integrate deliverables into release candidate',
        description: 'Integrate all deliverables, resolve conflicts between write scopes, and produce the release candidate.',
        acceptanceCriteria: 'Integrated build succeeds end-to-end and the release candidate is reproducible.',
        priority: 'critical',
        blockedByKeys: ['tests', 'review'],
        writeScopes: ['integration/'],
      },
      {
        key: 'docs',
        title: 'Produce operator documentation and handoff notes',
        description: 'Write the operator-facing documentation, configuration reference, and handoff notes for the mission.',
        acceptanceCriteria: 'Documentation covers setup, operation, and known limitations of the delivered work.',
        priority: 'low',
        blockedByKeys: ['integration'],
        writeScopes: ['docs/'],
      },
    ];

    return {
      plannerName: this.name,
      tasks,
    };
  }
}
