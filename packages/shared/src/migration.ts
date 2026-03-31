export type PortStage =
  | 'planning'
  | 'scaffolded'
  | 'in_progress'
  | 'parity_pending'
  | 'ported';

export interface MigrationPackageStatus {
  packageName: string;
  stage: PortStage;
  notes: string;
}
