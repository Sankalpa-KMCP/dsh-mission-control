/** Typed mirrors of the Mission Control REST API responses. */

export type MissionStatus = 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type TaskStatus =
  | 'pending'
  | 'blocked'
  | 'ready'
  | 'in_progress'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type AgentStatus = 'idle' | 'busy' | 'stopping' | 'terminated';

export interface ModelRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface MissionPolicy {
  maxConcurrentWorkers: number;
  maxDelegationDepth: number;
  chiefModelRoute: ModelRoute;
  allowedWorkerRoute: ModelRoute;
  requireVerificationBeforeCompletion: boolean;
}

export interface Mission {
  id: string;
  title: string;
  description: string;
  status: MissionStatus;
  policy: MissionPolicy;
  chiefAgentId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  missionId: string;
  title: string;
  description: string;
  acceptanceCriteria?: string;
  status: TaskStatus;
  priority: 'critical' | 'high' | 'normal' | 'low';
  blockedBy: string[];
  writeScopes: string[];
  ownerAgentId?: string;
  revision: number;
  attemptCount: number;
  maxRetries: number;
  artifactRevision?: string;
  lastFailureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  missionId: string;
  role: 'chief' | 'worker';
  depth: number;
  parentAgentId?: string;
  assignedTaskId?: string;
  status: AgentStatus;
  modelRoute: ModelRoute;
  createdAt: string;
  updatedAt: string;
}

export interface MissionStats {
  tasksTotal: number;
  pending: number;
  blocked: number;
  ready: number;
  inProgress: number;
  verifying: number;
  completed: number;
  failed: number;
  cancelled: number;
  verificationsPassed: number;
  verificationsFailed: number;
  workersActive: number;
}

export interface MissionListItem {
  mission: Mission;
  stats: MissionStats;
}

export interface MissionDetail {
  mission: Mission;
  tasks: Task[];
  stats: MissionStats;
}

export interface VerificationRecord {
  id: string;
  taskId: string;
  artifactRevision: string;
  verifierAgentId: string;
  status: 'pending' | 'passed' | 'failed' | 'inconclusive' | 'stale';
  findings: string;
  evidence: string[];
  evaluatedAt: string;
}

export interface AuditEvent {
  id: string;
  sequence: number;
  missionId: string;
  eventType: string;
  entityId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SystemStatus {
  mode: 'simulation' | 'connected';
  connectedProvider: { configured: boolean; reason: string };
  capacity: { maxWorkers: number; activeOrReserved: number; available: number };
  limits: { maxDelegationDepth: number };
  modelRouting: {
    chiefRoute: ModelRoute;
    workerRoute: ModelRoute;
    noAutomaticSubstitution: true;
  };
  missions: { total: number; active: number };
  uptimeSec: number;
}

export interface Health {
  status: string;
  mode: string;
  uptimeSec: number;
  authRequired: boolean;
}

export interface RecoveryIntent {
  id: string;
  missionId: string;
  action: string;
  status: string;
  reason: string;
  detectedAt: string;
  resolvedAt?: string;
}

export interface RecoverySummary {
  reconciledActivations: number;
  uncertainReservationsHeld: number;
  releasedReservations: number;
  recoveredTasks: number;
}
