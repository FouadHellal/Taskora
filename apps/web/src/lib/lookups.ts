import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Named {
  id: number;
  name: string;
  isActive?: boolean;
  sortOrder?: number;
}
export interface Status extends Named {
  category: 'new' | 'open' | 'waiting' | 'resolved' | 'closed';
  color: string;
  pausesSla: boolean;
  isDefault: boolean;
}
export interface Priority extends Named {
  level: number;
  color: string;
  isDefault: boolean;
}
export interface IssueType extends Named {
  ticketTypeId: number | null;
}
export interface SubIssueType extends Named {
  issueTypeId: number;
  queueId: number | null;
}
export interface WorkType extends Named {
  hourlyRate: number | null;
  isBillable: boolean;
  code: string | null;
}
export interface CiType extends Named {
  category: string;
}
export interface LookupUser {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  isActive: boolean;
  isTechnician: boolean;
}
export interface CustomFieldDef {
  id: number;
  entity: string;
  key: string;
  label: string;
  type: string;
  options: string[];
  isRequired: boolean;
  isActive: boolean;
  helpText: string | null;
  /** Fields sharing a tab name are shown together on their own tab (tickets). */
  tab?: string | null;
}

export interface Lookups {
  statuses: Status[];
  priorities: Priority[];
  ticketTypes: Named[];
  sources: Named[];
  queues: Named[];
  issueTypes: IssueType[];
  subIssueTypes: SubIssueType[];
  workTypes: WorkType[];
  billingCodes: (Named & { code: string; kind: string })[];
  ciTypes: CiType[];
  slaPolicies: (Named & { isDefault: boolean })[];
  users: LookupUser[];
  customFields: CustomFieldDef[];
}

export function useLookups() {
  return useQuery({ queryKey: ['lookups'], queryFn: () => api.get<Lookups>('/lookups'), staleTime: 60_000 });
}

/** Options for a <Select>, active rows only (keeps the current value if inactive). */
export function opts<T extends Named>(rows: T[] | undefined, current?: number | null, label: (r: T) => string = (r) => r.name) {
  return (rows ?? []).filter((r) => r.isActive !== false || r.id === current).map((r) => ({ value: r.id, label: label(r) }));
}

export function userOpts(users: LookupUser[] | undefined, current?: number | null, techOnly = true) {
  return (users ?? [])
    .filter((u) => (u.isActive && (!techOnly || u.isTechnician)) || u.id === current)
    .map((u) => ({ value: u.id, label: `${u.firstName} ${u.lastName}` }));
}

export function byId<T extends { id: number }>(rows: T[] | undefined, id: number | null | undefined): T | undefined {
  return id == null ? undefined : rows?.find((r) => r.id === id);
}
