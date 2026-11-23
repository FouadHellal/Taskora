import type { SlaState } from '../badges';

export interface TicketDetail {
  id: number;
  ticketNumber: string;
  title: string;
  description: string | null;
  companyId: number;
  companyName: string;
  companyPhone: string | null;
  companyLogoUpdatedAt: string | null;
  contactId: number | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactMobile: string | null;
  contactTitle: string | null;
  locationId: number | null;
  locationName: string | null;
  configurationItemId: number | null;
  assignedUserId: number | null;
  assigneeName: string | null;
  creatorName: string | null;
  queueId: number | null;
  queueName: string | null;
  ticketTypeId: number | null;
  ticketTypeName: string | null;
  issueTypeId: number | null;
  issueTypeName: string | null;
  subIssueTypeId: number | null;
  subIssueTypeName: string | null;
  statusId: number;
  statusName: string;
  statusColor: string;
  statusCategory: string;
  priorityId: number;
  priorityName: string;
  priorityColor: string;
  priorityLevel: number;
  sourceId: number | null;
  sourceName: string | null;
  slaId: number | null;
  slaName: string | null;
  contractId: number | null;
  contractName: string | null;
  contractType: string | null;
  projectId: number | null;
  projectName: string | null;
  dueAt: string | null;
  estimatedHours: number | null;
  resolution: string | null;
  tags: string[];
  customFields: Record<string, unknown>;
  firstResponseAt: string | null;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  slaPausedAt: string | null;
  slaPausedMinutes: number;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  minutesWorked: number;
  billableMinutes: number;
  watchers: { userId: number; name: string }[];
  isWatching: boolean;
  sla: { firstResponse: SlaState; resolution: SlaState; overall: SlaState };
}

/** A time entry as listed in the ticket timeline. */
export interface TicketTimeEntry {
  id: number;
  userId: number;
  startedAt: string;
  durationMinutes: number;
  description: string;
  internalNotes: string | null;
  billable: boolean;
  workTypeId: number | null;
  workTypeName: string | null;
  status: string;
  contractCovered: boolean;
}

export type TimelineItem =
  | {
      kind: 'note';
      id: string;
      at: string;
      userName: string | null;
      /** The client contact who wrote it (portal or e-mail reply). */
      contactName?: string | null;
      note: { id: number; body: string; visibility: 'internal' | 'public'; kind: string; userId: number | null; contactId?: number | null; createdAt: string };
    }
  | { kind: 'event'; id: string; at: string; userName: string | null; event: { id: number; type: string; data: Record<string, unknown>; createdAt: string } }
  | {
      kind: 'time';
      id: string;
      at: string;
      userName: string | null;
      entry: TicketTimeEntry;
    }
  | { kind: 'attachment'; id: string; at: string; userName: string | null; file: { id: number; fileName: string; sizeBytes: number; mimeType: string } };
