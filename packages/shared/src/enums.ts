/**
 * Fixed vocabularies. Business values users may want to change (statuses,
 * priorities, queues, types…) live in database tables instead; these enums
 * only cover values the application logic depends on.
 */

function labels<T extends string>(entries: Record<T, string>) {
  return { values: Object.keys(entries) as [T, ...T[]], labels: entries };
}

/** Every configurable ticket status maps onto one behavioural category. */
export const STATUS_CATEGORY = labels({
  new: 'New',
  open: 'Open',
  waiting: 'Waiting',
  resolved: 'Resolved',
  closed: 'Closed',
});
export type StatusCategory = (typeof STATUS_CATEGORY.values)[number];

export const COMPANY_TYPE = labels({
  customer: 'Customer',
  prospect: 'Prospect',
  lead: 'Lead',
  vendor: 'Vendor',
  partner: 'Partner',
  internal: 'Internal',
});

export const NOTE_VISIBILITY = labels({ internal: 'Internal', public: 'Customer-visible' });

export const CI_LIFECYCLE = labels({
  planned: 'Planned',
  in_stock: 'In stock',
  active: 'Active',
  in_repair: 'In repair',
  retired: 'Retired',
  disposed: 'Disposed',
});

export const CI_CATEGORY = labels({
  workstation: 'Workstation',
  server: 'Server',
  network: 'Network',
  peripheral: 'Peripheral',
  mobile: 'Mobile',
  storage: 'Storage',
  software: 'Software',
  license: 'License',
  cloud: 'Cloud service',
  other: 'Other',
});

export const CI_RELATION_TYPE = labels({
  connected_to: 'Connected to',
  depends_on: 'Depends on',
  hosts: 'Hosts',
  runs_on: 'Runs on',
  backs_up: 'Backs up',
  licensed_for: 'Licensed for',
});

export const TICKET_RELATION_TYPE = labels({
  related: 'Related',
  duplicate_of: 'Duplicate of',
  parent_of: 'Parent of',
  child_of: 'Child of',
  caused_by: 'Caused by',
});

export const CONTRACT_TYPE = labels({
  time_materials: 'Time & Materials',
  fixed_price: 'Fixed Price',
  block_hours: 'Block Hours',
  retainer: 'Retainer',
  recurring: 'Recurring Services',
  per_ticket: 'Per Ticket',
});
export type ContractType = (typeof CONTRACT_TYPE.values)[number];

export const CONTRACT_STATUS = labels({
  draft: 'Draft',
  active: 'Active',
  expired: 'Expired',
  cancelled: 'Cancelled',
});

export const BILLING_PERIOD = labels({
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semi_annual: 'Semi-annual',
  annual: 'Annual',
  one_time: 'One-time',
});

/** What a service is priced per (MSP per-device / per-user pricing). */
export const SERVICE_QUANTITY_SOURCE = labels({
  manual: 'Fixed quantity',
  devices: 'Per device',
  users: 'Per user',
});

export const TIME_ENTRY_STATUS = labels({
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
  billed: 'Billed',
});

export const INVOICE_STATUS = labels({
  draft: 'Draft',
  issued: 'Issued',
  paid: 'Paid',
  void: 'Void',
});

export const PROJECT_STATUS = labels({
  planning: 'Planning',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  cancelled: 'Cancelled',
});

export const TASK_STATUS = labels({
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
});

export const OPPORTUNITY_STAGE = labels({
  qualification: 'Qualification',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
});

export const KB_VISIBILITY = labels({ internal: 'Internal', public: 'Public' });
export const KB_STATUS = labels({ draft: 'Draft', published: 'Published', archived: 'Archived' });

export const SERVICE_CALL_STATUS = labels({
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
});

export const CUSTOM_FIELD_ENTITY = labels({
  company: 'Company',
  contact: 'Contact',
  ticket: 'Ticket',
  configuration_item: 'Configuration item',
  contract: 'Contract',
  project: 'Project',
});
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITY.values)[number];

export const CUSTOM_FIELD_TYPE = labels({
  text: 'Text',
  textarea: 'Long text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / No',
  select: 'Picklist',
  url: 'URL',
});
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPE.values)[number];

export const ACTIVITY_TYPE = labels({
  note: 'Note',
  call: 'Phone call',
  email: 'Email',
  meeting: 'Meeting',
  task: 'To-do',
});

export const SYNC_STATUS = labels({
  running: 'Running',
  success: 'Success',
  partial: 'Partial',
  failed: 'Failed',
});

export const ENDPOINT_MATCH_STATUS = labels({
  matched: 'Matched',
  created: 'Created CI',
  unmatched: 'Needs review',
  conflict: 'Conflict',
  ignored: 'Ignored',
  unmapped_org: 'Organization not mapped',
});

export const ACTION1_REGIONS = labels({
  na: 'North America (app.action1.com)',
  'na-2': 'North America 2 (app.na-2.action1.com)',
  eu: 'Europe (app.eu.action1.com)',
  uk: 'United Kingdom (app.uk.action1.com)',
  au: 'Australia (app.au.action1.com)',
});

export const WORKFLOW_TRIGGER = labels({
  'ticket.created': 'Ticket is created',
  'ticket.updated': 'Ticket is updated',
  'ticket.status_age': 'Ticket remains in a status for a period',
  'ticket.sla_breached': 'Ticket breaches an SLA target',
});
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGER.values)[number];

export const WORKFLOW_ACTION = labels({
  set_queue: 'Set queue',
  set_priority: 'Set priority',
  set_status: 'Set status',
  assign_user: 'Assign technician',
  set_sla: 'Apply SLA policy',
  notify_user: 'Notify a user',
  notify_assignee: 'Notify assigned technician',
  add_note: 'Add internal note',
  add_tag: 'Add tag',
});
export type WorkflowActionType = (typeof WORKFLOW_ACTION.values)[number];

export const WORKFLOW_OPERATOR = labels({
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  contains: 'contains',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
});
export type WorkflowOperator = (typeof WORKFLOW_OPERATOR.values)[number];

export const WORKFLOW_FIELDS = labels({
  priorityId: 'Priority',
  statusId: 'Status',
  queueId: 'Queue',
  ticketTypeId: 'Ticket type',
  issueTypeId: 'Issue type',
  sourceId: 'Source',
  companyId: 'Company',
  assignedUserId: 'Assigned technician',
  title: 'Title',
  description: 'Description',
});
export type WorkflowField = (typeof WORKFLOW_FIELDS.values)[number];
