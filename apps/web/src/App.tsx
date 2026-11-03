import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Permission } from '@taskora/shared';
import { api } from './lib/api';
import { useAuth } from './lib/auth';
import { AppShell } from './components/layout/app-shell';
import { EmptyState, PageLoader } from './components/ui/misc';
import { ErrorBoundary } from './components/error-boundary';
import LoginPage from './pages/auth/login';
import SetupPage from './pages/auth/setup';

const PortalApp = lazy(() => import('./pages/portal/index'));

const page = (loader: () => Promise<{ default: ComponentType<any> }>) => lazy(loader);

const Dashboard = page(() => import('./pages/dashboard'));
const MyWork = page(() => import('./pages/workspace/my-work'));
const CalendarPage = page(() => import('./pages/workspace/calendar'));
const Notifications = page(() => import('./pages/workspace/notifications'));
const TicketList = page(() => import('./pages/tickets/list'));
const TicketNew = page(() => import('./pages/tickets/new'));
const TicketDetail = page(() => import('./pages/tickets/detail'));
const Queues = page(() => import('./pages/tickets/queues'));
const ServiceCalls = page(() => import('./pages/tickets/service-calls'));
const SlaMonitor = page(() => import('./pages/tickets/sla-monitor'));
const RecurringTickets = page(() => import('./pages/tickets/recurring'));
const Dispatch = page(() => import('./pages/tickets/dispatch'));
const Companies = page(() => import('./pages/crm/companies'));
const CompanyDetail = page(() => import('./pages/crm/company-detail'));
const Contacts = page(() => import('./pages/crm/contacts'));
const ContactDetail = page(() => import('./pages/crm/contact-detail'));
const Locations = page(() => import('./pages/crm/locations'));
const Opportunities = page(() => import('./pages/crm/opportunities'));
const Assets = page(() => import('./pages/assets/list'));
const AssetDetail = page(() => import('./pages/assets/detail'));
const Devices = page(() => import('./pages/assets/devices'));
const Products = page(() => import('./pages/assets/products'));
const AssetTypes = page(() => import('./pages/assets/asset-types'));
const Software = page(() => import('./pages/assets/software'));
const Action1Endpoints = page(() => import('./pages/integrations/action1-endpoints'));
const AtlasIntegration = page(() => import('./pages/integrations/atlas'));
const Contracts = page(() => import('./pages/business/contracts'));
const ContractDetail = page(() => import('./pages/business/contract-detail'));
const TimeEntries = page(() => import('./pages/business/time'));
const Billing = page(() => import('./pages/business/billing'));
const Invoices = page(() => import('./pages/business/invoices'));
const InvoiceDetail = page(() => import('./pages/business/invoice-detail'));
const Services = page(() => import('./pages/business/services'));
const Projects = page(() => import('./pages/projects/list'));
const ProjectDetail = page(() => import('./pages/projects/detail'));
const Tasks = page(() => import('./pages/projects/tasks'));
const Milestones = page(() => import('./pages/projects/milestones'));
const KnowledgeBase = page(() => import('./pages/kb/list'));
const KbArticle = page(() => import('./pages/kb/article'));
const KbEditor = page(() => import('./pages/kb/editor'));
const Documentation = page(() => import('./pages/kb/documentation'));
const Reports = page(() => import('./pages/insights/reports'));
const Analytics = page(() => import('./pages/insights/analytics'));
const AdminUsers = page(() => import('./pages/admin/users'));
const AdminTicketSettings = page(() => import('./pages/admin/ticket-settings'));
const AdminWorkflows = page(() => import('./pages/admin/workflows'));
const AdminCustomFields = page(() => import('./pages/admin/custom-fields'));
const AdminIntegrations = page(() => import('./pages/admin/integrations'));
const AdminSystem = page(() => import('./pages/admin/system'));
const AdminAudit = page(() => import('./pages/admin/audit'));
const AdminImport = page(() => import('./pages/admin/import'));
const AdminEmail = page(() => import('./pages/admin/email'));
const AdminBackups = page(() => import('./pages/admin/backups'));

function Guard({ perm, children }: { perm?: Permission; children: ReactNode }) {
  const { can } = useAuth();
  if (perm && !can(perm)) return <EmptyState title="Access denied" description="Your role does not have permission to view this page." />;
  return <>{children}</>;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsSetup: boolean }>('/setup/status'), enabled: !loading && !me, staleTime: 60_000 });
  if (loading || (!me && setup.isLoading)) return <PageLoader />;
  if (!me) return <Navigate to={setup.data?.needsSetup ? '/setup' : '/login'} replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

const r = (path: string, Comp: ComponentType<any>, perm?: Permission, props?: Record<string, unknown>) => (
  <Route
    key={path}
    path={path}
    element={
      <Guard perm={perm}>
        <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
            <Comp {...props} />
          </Suspense>
        </ErrorBoundary>
      </Guard>
    }
  />
);

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route
        path="/portal/*"
        element={
          <Suspense fallback={<PageLoader />}>
            <PortalApp />
          </Suspense>
        }
      />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        {r('/', Dashboard, 'dashboard.read')}
        {r('/my-work', MyWork)}
        {r('/calendar', CalendarPage)}
        {r('/notifications', Notifications)}
        {r('/tickets', TicketList, 'tickets.read', { preset: 'all' })}
        {r('/tickets/mine', TicketList, 'tickets.read', { preset: 'mine' })}
        {r('/tickets/unassigned', TicketList, 'tickets.read', { preset: 'unassigned' })}
        {r('/tickets/queues', Queues, 'tickets.read')}
        {r('/tickets/new', TicketNew, 'tickets.write')}
        {r('/tickets/:id', TicketDetail, 'tickets.read')}
        {r('/service-calls', ServiceCalls, 'tickets.read')}
        {r('/sla-monitor', SlaMonitor, 'tickets.read')}
        {r('/recurring-tickets', RecurringTickets, 'tickets.read')}
        {r('/dispatch', Dispatch, 'tickets.read')}
        {r('/companies', Companies, 'companies.read')}
        {r('/companies/:id', CompanyDetail, 'companies.read')}
        {r('/contacts', Contacts, 'companies.read')}
        {r('/contacts/:id', ContactDetail, 'companies.read')}
        {r('/locations', Locations, 'companies.read')}
        {r('/opportunities', Opportunities, 'opportunities.read')}
        {r('/assets', Assets, 'cis.read')}
        {r('/assets/devices', Devices, 'cis.read')}
        {r('/assets/:id', AssetDetail, 'cis.read')}
        {r('/products', Products, 'cis.read')}
        {r('/asset-types', AssetTypes, 'cis.read')}
        {r('/software', Software, 'cis.read')}
        {r('/integrations/action1/endpoints', Action1Endpoints, 'integrations.read')}
        {r('/integrations/atlas', AtlasIntegration, 'integrations.read')}
        {r('/contracts', Contracts, 'contracts.read')}
        {r('/contracts/:id', ContractDetail, 'contracts.read')}
        {r('/time', TimeEntries, 'time.read')}
        {r('/billing', Billing, 'billing.read')}
        {r('/invoices', Invoices, 'billing.read')}
        {r('/invoices/:id', InvoiceDetail, 'billing.read')}
        {r('/services', Services, 'contracts.read')}
        {r('/projects', Projects, 'projects.read')}
        {r('/projects/:id', ProjectDetail, 'projects.read')}
        {r('/tasks', Tasks, 'projects.read')}
        {r('/milestones', Milestones, 'projects.read')}
        {r('/kb', KnowledgeBase, 'kb.read')}
        {r('/kb/new', KbEditor, 'kb.write')}
        {r('/kb/:id', KbArticle, 'kb.read')}
        {r('/kb/:id/edit', KbEditor, 'kb.write')}
        {r('/documentation', Documentation, 'kb.read')}
        {r('/reports', Reports, 'reports.read')}
        {r('/analytics', Analytics, 'reports.read')}
        {r('/admin/users', AdminUsers, 'users.manage')}
        {r('/admin/ticket-settings', AdminTicketSettings, 'settings.manage')}
        {r('/admin/workflows', AdminWorkflows, 'automation.manage')}
        {r('/admin/custom-fields', AdminCustomFields, 'settings.manage')}
        {r('/admin/integrations', AdminIntegrations, 'integrations.read')}
        {r('/admin/system', AdminSystem, 'settings.manage')}
        {r('/admin/audit', AdminAudit, 'audit.read')}
        {r('/admin/import', AdminImport, 'companies.write')}
        {r('/admin/email', AdminEmail, 'settings.manage')}
        {r('/admin/backups', AdminBackups, 'backups.manage')}
        <Route path="*" element={<EmptyState title="Page not found" description="The page you are looking for does not exist." />} />
      </Route>
    </Routes>
  );
}
