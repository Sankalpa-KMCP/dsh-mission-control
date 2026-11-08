/**
 * Type and interface integrity check for DSH Mission Control.
 * Validates module exports, TypeScript syntax parsing, and contract adherence.
 */

console.log('--- Verifying Type and Interface Integrity ---');

// Import all packages to verify type stripping, export completeness, and syntax
import * as Contracts from '../packages/contracts/src/index.ts';
import * as Kernel from '../packages/kernel/src/index.ts';
import * as RuntimeSimulator from '../packages/runtime-simulator/src/index.ts';
import * as DshAdapter from '../packages/dsh-adapter/src/index.ts';

console.log(`✓ Contracts package loaded: ${Object.keys(Contracts).length} exports`);
console.log(`✓ Kernel package loaded: ${Object.keys(Kernel).length} exports`);
console.log(`✓ Runtime Simulator package loaded: ${Object.keys(RuntimeSimulator).length} exports`);
console.log(`✓ DSH Adapter package loaded: ${Object.keys(DshAdapter).length} exports`);

// Runtime contract assertions
if (Contracts.MAX_WORKER_CAPACITY !== 16) {
  throw new Error(`Integrity violation: MAX_WORKER_CAPACITY must be 16, got ${Contracts.MAX_WORKER_CAPACITY}`);
}
if (Contracts.MAX_DELEGATION_DEPTH !== 3) {
  throw new Error(`Integrity violation: MAX_DELEGATION_DEPTH must be 3, got ${Contracts.MAX_DELEGATION_DEPTH}`);
}
if (Contracts.AUTHORIZED_WORKER_PROVIDER !== 'antigravity-manager') {
  throw new Error(`Integrity violation: AUTHORIZED_WORKER_PROVIDER must be antigravity-manager`);
}
if (Contracts.AUTHORIZED_WORKER_MODEL !== 'Gemini-3.8-flash') {
  throw new Error(`Integrity violation: AUTHORIZED_WORKER_MODEL must be Gemini-3.8-flash`);
}
if (DshAdapter.PINNED_DSH_CORE_COMMIT !== 'b830ec950faba0a46dda564be3e2d854afed94f1') {
  throw new Error(`Integrity violation: Pinned commit mismatch`);
}

console.log('✓ All architectural contract invariants verified successfully.\n');
