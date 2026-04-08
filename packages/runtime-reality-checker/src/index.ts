export type {
  StartupMode,
  ProcessStatus,
  ExpectedProcess,
  ActualProcessState,
  DriftItem,
  RealityCheckResult,
  ProcessCheckResult,
} from "./lib.js";
export {
  checkProcesses,
  buildDriftItems,
  runRealityCheck,
  hasCriticalDrift,
  getCriticalDrift,
} from "./lib.js";
