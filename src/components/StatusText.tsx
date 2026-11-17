import { AlertTriangle, CheckCircle2, Clock, FileCheck, XCircle } from 'lucide-react';

interface StatusTextProps {
  status: string;
}

const STATUS_MAP: Record<string, { label: string; colorClass: string; Icon: typeof CheckCircle2 }> = {
  ACTIVE: { label: 'Active', colorClass: 'text-emerald-700', Icon: CheckCircle2 },
  APPROVED: { label: 'Approved', colorClass: 'text-emerald-700', Icon: CheckCircle2 },
  COMMITTED: { label: 'Committed', colorClass: 'text-emerald-700', Icon: CheckCircle2 },
  MATCH: { label: 'MATCH', colorClass: 'text-emerald-700', Icon: CheckCircle2 },
  SURVEY_VERIFIED: { label: 'Survey Verified', colorClass: 'text-blue-700', Icon: FileCheck },
  CLERK_VERIFIED: { label: 'Clerk Verified', colorClass: 'text-blue-700', Icon: FileCheck },
  AWAITING_APPROVAL: { label: 'Awaiting Approval', colorClass: 'text-amber-700', Icon: Clock },
  SURVEY_IN_PROGRESS: { label: 'Survey In Progress', colorClass: 'text-blue-700', Icon: Clock },
  UNDER_MUTATION: { label: 'Under Mutation', colorClass: 'text-amber-700', Icon: Clock },
  SUBMITTED: { label: 'Submitted', colorClass: 'text-slate-700', Icon: Clock },
  RETURNED_FOR_CORRECTION: { label: 'Returned for Correction', colorClass: 'text-amber-700', Icon: AlertTriangle },
  ESCALATED: { label: 'Escalated', colorClass: 'text-amber-700', Icon: AlertTriangle },
  DISPUTED: { label: 'Disputed', colorClass: 'text-red-700', Icon: AlertTriangle },
  REJECTED: { label: 'Rejected', colorClass: 'text-red-700', Icon: XCircle },
  FAILED: { label: 'Failed', colorClass: 'text-red-700', Icon: XCircle },
  NO_MATCH: { label: 'NO MATCH', colorClass: 'text-red-700', Icon: XCircle },
  LOCKED: { label: 'Locked', colorClass: 'text-red-700', Icon: XCircle },
  SUSPENDED: { label: 'Suspended', colorClass: 'text-red-700', Icon: XCircle }
};

export function StatusText({ status }: StatusTextProps) {
  const entry = STATUS_MAP[status] || {
    label: status.replace(/_/g, ' '),
    colorClass: 'text-slate-700',
    Icon: Clock
  };
  const Icon = entry.Icon;

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap ${entry.colorClass}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>{entry.label}</span>
    </span>
  );
}
