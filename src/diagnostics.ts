export interface CcDiagnostic {
  line: number;
  col: number;
  message: string;
  severity: 'error' | 'warning';
}
