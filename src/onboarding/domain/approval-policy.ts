/** Política de aprovação por workspace. AUTOMATIC aprova na submissão; MANUAL deixa PENDING para o facilitador. */
export const APPROVAL_MODES = ['AUTOMATIC', 'MANUAL'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Sem revisão gravada (revisão 0), o fluxo normal: aprovação automática. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'AUTOMATIC';

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value);
}

/** Estados da solicitação e a decisão do facilitador sobre uma PENDING. */
export type OnboardingStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type OnboardingDecision = 'APPROVED' | 'REJECTED';

export function isOnboardingStatus(value: unknown): value is OnboardingStatus {
  return value === 'PENDING' || value === 'APPROVED' || value === 'REJECTED';
}
