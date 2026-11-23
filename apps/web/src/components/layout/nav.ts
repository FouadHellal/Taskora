import {
  Activity,
  Wifi,
  FileBarChart,
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  Briefcase,
  Building2,
  Calendar,
  CircleHelp,
  CalendarClock,
  CalendarRange,
  ClipboardList,
  Clock,
  Cog,
  Contact,
  Cpu,
  CreditCard,
  DatabaseBackup,
  FileClock,
  FileSignature,
  FileText,
  FileUp,
  Flag,
  FolderKanban,
  Gauge,
  HardDrive,
  Headset,
  Inbox,
  KeyRound,
  Layers,
  LayoutDashboard,
  Library,
  ListChecks,
  ListTodo,
  Mail,
  MapPin,
  Milestone,
  Package,
  PhoneCall,
  Plug,
  Receipt,
  Repeat,
  ScrollText,
  Settings,
  Settings2,
  Shapes,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Ticket,
  TrendingUp,
  UserRound,
  Users,
  Wallet,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@taskora/shared';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  perm?: Permission;
  /** Key in /tickets/counts used for a badge. */
  badge?: 'mine' | 'unassigned' | 'breached';
  end?: boolean;
}

/** A sub-menu inside a section: a collapsible row with its own items. */
export interface NavGroup {
  label: string;
  icon: LucideIcon;
  children: NavItem[];
}

export type NavEntry = NavItem | NavGroup;

export interface NavSection {
  label: string;
  icon: LucideIcon;
  items: NavEntry[];
}

export const isGroup = (e: NavEntry): e is NavGroup => 'children' in e;

export const NAV: NavSection[] = [
  {
    label: 'Workspace',
    icon: LayoutDashboard,
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard, perm: 'dashboard.read', end: true },
      { label: 'My Work', to: '/my-work', icon: ListTodo },
      { label: 'Calendar', to: '/calendar', icon: Calendar },
      { label: 'Notifications', to: '/notifications', icon: Bell },
      { label: 'Help & Guides', to: '/help', icon: CircleHelp },
    ],
  },
  {
    label: 'Service Desk',
    icon: Headset,
    items: [
      {
        label: 'Tickets',
        icon: Ticket,
        children: [
          { label: 'All Tickets', to: '/tickets', icon: Ticket, perm: 'tickets.read', end: true },
          { label: 'My Tickets', to: '/tickets/mine', icon: Inbox, perm: 'tickets.read', badge: 'mine' },
          { label: 'Unassigned', to: '/tickets/unassigned', icon: Flag, perm: 'tickets.read', badge: 'unassigned' },
          { label: 'Queues', to: '/tickets/queues', icon: Layers, perm: 'tickets.read' },
          { label: 'Recurring Tickets', to: '/recurring-tickets', icon: Repeat, perm: 'tickets.read' },
        ],
      },
      {
        label: 'Scheduling',
        icon: CalendarRange,
        children: [
          { label: 'Service Calls', to: '/service-calls', icon: PhoneCall, perm: 'tickets.read' },
          { label: 'Dispatch', to: '/dispatch', icon: CalendarRange, perm: 'tickets.read' },
        ],
      },
      { label: 'SLA Monitor', to: '/sla-monitor', icon: Gauge, perm: 'tickets.read', badge: 'breached' },
    ],
  },
  {
    label: 'Customers',
    icon: Building2,
    items: [
      { label: 'Companies', to: '/companies', icon: Building2, perm: 'companies.read' },
      { label: 'Contacts', to: '/contacts', icon: Contact, perm: 'companies.read' },
      { label: 'Locations', to: '/locations', icon: MapPin, perm: 'companies.read' },
      { label: 'Opportunities', to: '/opportunities', icon: TrendingUp, perm: 'opportunities.read' },
    ],
  },
  {
    label: 'Assets',
    icon: HardDrive,
    items: [
      { label: 'Configuration Items', to: '/assets', icon: HardDrive, perm: 'cis.read', end: true },
      { label: 'Devices', to: '/assets/devices', icon: Cpu, perm: 'cis.read' },
      {
        label: 'Catalog',
        icon: Shapes,
        children: [
          { label: 'Products', to: '/products', icon: Package, perm: 'cis.read' },
          { label: 'Asset Types', to: '/asset-types', icon: Boxes, perm: 'cis.read' },
          { label: 'Software', to: '/software', icon: Layers, perm: 'cis.read' },
        ],
      },
      { label: 'Action1 Endpoints', to: '/integrations/action1/endpoints', icon: Plug, perm: 'integrations.read' },
      { label: 'Omada Wi-Fi', to: '/integrations/omada', icon: Wifi, perm: 'integrations.read' },
    ],
  },
  {
    label: 'Business',
    icon: Wallet,
    items: [
      { label: 'Contracts', to: '/contracts', icon: FileSignature, perm: 'contracts.read' },
      { label: 'Services', to: '/services', icon: Briefcase, perm: 'contracts.read' },
      { label: 'Time Entries', to: '/time', icon: Clock, perm: 'time.read' },
      {
        label: 'Billing',
        icon: CreditCard,
        children: [
          { label: 'Billing Review', to: '/billing', icon: CreditCard, perm: 'billing.read' },
          { label: 'Invoices', to: '/invoices', icon: Receipt, perm: 'billing.read' },
        ],
      },
    ],
  },
  {
    label: 'Projects & Knowledge',
    icon: FolderKanban,
    items: [
      {
        label: 'Projects',
        icon: FolderKanban,
        children: [
          { label: 'All Projects', to: '/projects', icon: FolderKanban, perm: 'projects.read' },
          { label: 'Tasks', to: '/tasks', icon: ListChecks, perm: 'projects.read' },
          { label: 'Milestones', to: '/milestones', icon: Milestone, perm: 'projects.read' },
        ],
      },
      {
        label: 'Knowledge',
        icon: Library,
        children: [
          { label: 'Knowledge Base', to: '/kb', icon: BookOpen, perm: 'kb.read' },
          { label: 'Documentation', to: '/documentation', icon: FileText, perm: 'kb.read' },
        ],
      },
    ],
  },
  {
    label: 'Insights',
    icon: BarChart3,
    items: [
      { label: 'Reports', to: '/reports', icon: BarChart3, perm: 'reports.read' },
      { label: 'Analytics', to: '/analytics', icon: Activity, perm: 'reports.read' },
      { label: 'Client reports', to: '/client-reports', icon: FileBarChart, perm: 'companies.read' },
    ],
  },
  {
    label: 'Administration',
    icon: Settings2,
    items: [
      { label: 'Settings', to: '/settings', icon: Settings, end: false },
      {
        label: 'People & Access',
        icon: Users,
        children: [
          { label: 'Users & Roles', to: '/admin/users', icon: Users, perm: 'users.manage' },
          { label: 'Client Portal', to: '/admin/portal', icon: Building2, perm: 'companies.read' },
          { label: 'Audit Logs', to: '/admin/audit', icon: ScrollText, perm: 'audit.read' },
        ],
      },
      {
        label: 'Service Desk Setup',
        icon: SlidersHorizontal,
        children: [
          { label: 'Ticket Settings', to: '/admin/ticket-settings', icon: ClipboardList, perm: 'settings.manage' },
          { label: 'Workflow Rules', to: '/admin/workflows', icon: Workflow, perm: 'automation.manage' },
          { label: 'Custom Fields', to: '/admin/custom-fields', icon: Tags, perm: 'settings.manage' },
        ],
      },
      {
        label: 'Integrations & Data',
        icon: Plug,
        children: [
          { label: 'Integrations', to: '/admin/integrations', icon: Plug, perm: 'integrations.read' },
          { label: 'E-mail', to: '/admin/email', icon: Mail, perm: 'settings.manage' },
          { label: 'Data Import', to: '/admin/import', icon: FileUp, perm: 'companies.write' },
        ],
      },
      {
        label: 'System',
        icon: Cog,
        children: [
          { label: 'System Settings', to: '/admin/system', icon: Settings2, perm: 'settings.manage' },
          { label: 'Backup & Restore', to: '/admin/backups', icon: DatabaseBackup, perm: 'backups.manage' },
        ],
      },
    ],
  },
];

/** Every page link, in menu order (command palette, search). */
export function flatNav(sections: NavSection[] = NAV): NavItem[] {
  return sections.flatMap((s) => s.items.flatMap((e) => (isGroup(e) ? e.children : [e])));
}

/** Whether `item` is the page at `pathname` (`end` = exact match, else prefix). */
export function isActive(item: Pick<NavItem, 'to' | 'end'>, pathname: string, exact = item.end) {
  if (exact || item.to === '/') return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

// Re-exported so pages can reuse consistent icons.
export const ICONS = { Building2, Contact, HardDrive, Ticket, FileSignature, FolderKanban, BookOpen, Clock, UserRound, CalendarClock, FileClock, ShieldCheck, KeyRound, Sparkles, Cog };
