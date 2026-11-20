/**
 * Development-only demo dataset. Everything below is FICTIONAL: companies, people,
 * addresses (*.example / *.demo domains, 555 phone numbers), serial numbers, KB numbers
 * and the Action1 snapshot. Never run this against a production database.
 *
 * Randomness comes from a seeded PRNG so a fresh database always gets the same data
 * (relative to `now`); only the shared demo password is truly random.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { formatNumber, type TicketInput } from '@taskora/shared';
import type { Db, Tx } from '../client.js';
import * as s from '../schema/index.js';
import { hashPassword, randomToken } from '../../lib/crypto.js';
import { nextSequence } from '../../lib/query.js';
import { getSystemSettings, saveSystemSettings } from '../../lib/settings.js';
import { addTicketNote, createTicket, updateTicket, type TicketCtx } from '../../modules/tickets/service.js';
import { classifyTime, resolveTimeContext } from '../../modules/time/service.js';
import { recomputeCoverage } from '../../modules/contracts/coverage.js';

export interface SeedDemoOptions {
  now?: Date;
  log?: (msg: string) => void;
}

export interface SeedDemoResult {
  users: { email: string; password: string; role: string }[];
}

export const DEMO_MARKER_COMPANY = 'Northstar Consulting';

/* ------------------------------------------------------------------ utils */

const MIN = 60_000;
const DAY = 86_400_000;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  /** Integer in [min, max] rounded to a multiple of `step`. */
  step(min: number, max: number, step = 5): number {
    return Math.max(min, Math.round(this.int(min, max) / step) * step);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  chars(n: number, alphabet = 'BCDFGHJKLMNPQRSTVWXYZ0123456789'): string {
    let out = '';
    for (let i = 0; i < n; i++) out += alphabet[Math.floor(this.next() * alphabet.length)];
    return out;
  }
}

const BXL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function brussels(d: Date): { wd: string; hour: number } {
  const parts = BXL.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { wd: get('weekday'), hour: Number(get('hour')) };
}

function isBusinessTime(d: Date): boolean {
  const { wd, hour } = brussels(d);
  return wd !== 'Sat' && wd !== 'Sun' && hour >= 8 && hour < 18;
}

/** Moves a timestamp forward into Brussels office hours (Mon–Fri 08:00–18:00). */
function bizShift(d: Date): Date {
  let x = new Date(d);
  for (let i = 0; i < 400 && !isBusinessTime(x); i++) x = new Date(x.getTime() + 30 * MIN);
  return x;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * MIN);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

function slug(v: string): string {
  return v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function generatePassword(): string {
  // ~108 bits of entropy plus fixed character classes for password policies.
  return `Demo-${randomToken(18)}-7a`;
}

/* ------------------------------------------------------------ static data */

type UserKey = 'admin' | 'sarah' | 'lucas' | 'noor' | 'tom' | 'ilse';
type CoKey = 'lumen' | 'ns' | 'bp' | 'mt' | 'hd' | 'af' | 'cl';
type Prio = 'Critical' | 'High' | 'Medium' | 'Low';
type Outcome = 'new' | 'in_progress' | 'waiting_customer' | 'waiting_vendor' | 'scheduled' | 'escalated' | 'resolved' | 'closed';

const USERS: { key: UserKey; first: string; last: string; role: string; title: string; tech: boolean; cost: number | null; phone: string }[] = [
  { key: 'sarah', first: 'Sarah', last: 'Jensen', role: 'service_desk_manager', title: 'Service Desk Manager', tech: true, cost: 48, phone: '+32 2 555 0191' },
  { key: 'lucas', first: 'Lucas', last: 'Peeters', role: 'technician', title: 'Senior Systems Engineer', tech: true, cost: 44, phone: '+32 2 555 0192' },
  { key: 'noor', first: 'Noor', last: 'Vermeulen', role: 'technician', title: 'Service Desk Technician', tech: true, cost: 34, phone: '+32 2 555 0193' },
  { key: 'tom', first: 'Tom', last: 'De Smet', role: 'technician', title: 'Project Engineer', tech: true, cost: 40, phone: '+32 2 555 0194' },
  { key: 'ilse', first: 'Ilse', last: 'Maes', role: 'read_only', title: 'Finance & Account Coordinator', tech: false, cost: null, phone: '+32 2 555 0195' },
];
/** Only created when the instance has no administrator yet (otherwise first-run setup would be skipped with no admin). */
const DEMO_ADMIN = { key: 'admin' as const, first: 'Alex', last: 'Morgan', role: 'administrator', title: 'Managing Director', tech: false, cost: null, phone: '+32 2 555 0190' };

interface CompanySpec {
  key: CoKey;
  name: string;
  accountNumber: string;
  type: string;
  industry: string;
  domain: string;
  phone: string;
  address1: string;
  city: string;
  postalCode: string;
  country: string;
  state?: string;
  sla?: 'Standard SLA' | 'Premium SLA';
  manager: UserKey;
  notes: string;
  locations: { name: string; address1: string; city: string; postalCode: string; phone?: string; primary?: boolean }[];
}

const COMPANIES: CompanySpec[] = [
  {
    key: 'lumen',
    name: 'Lumen IT Services',
    accountNumber: 'INT-0001',
    type: 'internal',
    industry: 'IT managed services',
    domain: 'lumen-it.example',
    phone: '+32 2 555 0100',
    address1: 'Rue des Tisserands 9',
    city: 'Brussels',
    postalCode: '1000',
    country: 'Belgium',
    manager: 'sarah',
    notes: 'Our own MSP (internal company) — used for internal tickets and admin time. Fictional demo data.',
    locations: [{ name: 'Head office', address1: 'Rue des Tisserands 9', city: 'Brussels', postalCode: '1000', primary: true }],
  },
  {
    key: 'ns',
    name: 'Northstar Consulting',
    accountNumber: 'C-1001',
    type: 'customer',
    industry: 'Management consulting',
    domain: 'northstar-consulting.example',
    phone: '+32 2 555 0110',
    address1: 'Rue des Alouettes 14',
    city: 'Brussels',
    postalCode: '1050',
    country: 'Belgium',
    sla: 'Premium SLA',
    manager: 'sarah',
    notes: '25 employees. Fully managed (workstations, servers, Microsoft 365). Partners expect fast turnaround before client workshops.',
    locations: [{ name: 'Brussels office', address1: 'Rue des Alouettes 14', city: 'Brussels', postalCode: '1050', phone: '+32 2 555 0110', primary: true }],
  },
  {
    key: 'bp',
    name: 'BluePeak Logistics',
    accountNumber: 'C-1002',
    type: 'customer',
    industry: 'Logistics & warehousing',
    domain: 'bluepeak-logistics.example',
    phone: '+32 3 555 0120',
    address1: 'Havenweg 220',
    city: 'Antwerp',
    postalCode: '2030',
    country: 'Belgium',
    sla: 'Standard SLA',
    manager: 'tom',
    notes: 'Two sites: Antwerp HQ (office) and Mechelen warehouse (24/6 operations, handheld scanners on Wi-Fi). Prepaid block hours.',
    locations: [
      { name: 'Antwerp HQ', address1: 'Havenweg 220', city: 'Antwerp', postalCode: '2030', phone: '+32 3 555 0120', primary: true },
      { name: 'Mechelen warehouse', address1: 'Industrieweg 41', city: 'Mechelen', postalCode: '2800', phone: '+32 15 555 0121' },
    ],
  },
  {
    key: 'mt',
    name: 'Meridian Technologies',
    accountNumber: 'C-1003',
    type: 'customer',
    industry: 'Software development',
    domain: 'meridian-tech.example',
    phone: '+31 30 555 0130',
    address1: 'Kanaalkade 70',
    city: 'Utrecht',
    postalCode: '3511 AB',
    country: 'Netherlands',
    manager: 'sarah',
    notes: 'SaaS start-up, mixed macOS/Windows fleet. Time & materials; developers have local admin by exception only.',
    locations: [{ name: 'Utrecht office', address1: 'Kanaalkade 70', city: 'Utrecht', postalCode: '3511 AB', primary: true }],
  },
  {
    key: 'hd',
    name: 'Harbor Dental Group',
    accountNumber: 'C-1004',
    type: 'customer',
    industry: 'Healthcare (dental practice)',
    domain: 'harbordental.example',
    phone: '+32 16 555 0140',
    address1: 'Tiensevest 128',
    city: 'Leuven',
    postalCode: '3000',
    country: 'Belgium',
    sla: 'Standard SLA',
    manager: 'tom',
    notes: 'Small practice, patient records in on-premises practice management software (SQL Express on HD-SRV-01). Patch outside clinic hours only.',
    locations: [{ name: 'Leuven practice', address1: 'Tiensevest 128', city: 'Leuven', postalCode: '3000', primary: true }],
  },
  {
    key: 'af',
    name: 'Alder & Finch Legal',
    accountNumber: 'C-1005',
    type: 'customer',
    industry: 'Legal services',
    domain: 'alderfinch-legal.example',
    phone: '+31 10 555 0150',
    address1: 'Singelstraat 15',
    city: 'Rotterdam',
    postalCode: '3014 AA',
    country: 'Netherlands',
    sla: 'Standard SLA',
    manager: 'sarah',
    notes: 'Law firm, 8 staff. Document management system accessed over VPN. Monthly support retainer.',
    locations: [{ name: 'Rotterdam office', address1: 'Singelstraat 15', city: 'Rotterdam', postalCode: '3014 AA', primary: true }],
  },
  {
    key: 'cl',
    name: 'Copperleaf Architects',
    accountNumber: 'P-2001',
    type: 'prospect',
    industry: 'Architecture',
    domain: 'copperleaf-architects.example',
    phone: '+32 15 555 0160',
    address1: 'Veemarkt 3',
    city: 'Mechelen',
    postalCode: '2800',
    country: 'Belgium',
    manager: 'sarah',
    notes: 'Prospect — 12 workstations, heavy CAD users. Met at a regional business event.',
    locations: [{ name: 'Studio', address1: 'Veemarkt 3', city: 'Mechelen', postalCode: '2800', primary: true }],
  },
];

/** [first, last, title, department, active?, location index?] */
type ContactRow = [string, string, string, string, boolean?, number?];

const CONTACTS: Record<CoKey, { primary: string; rows: ContactRow[] }> = {
  lumen: { primary: '', rows: [] },
  ns: {
    primary: 'Charlotte Dubois',
    rows: [
      ['Pieter', 'Claes', 'Managing Partner', 'Management'],
      ['Charlotte', 'Dubois', 'Office Manager', 'Operations'],
      ['Jonas', 'Wouters', 'Consultant', 'Strategy'],
      ['Amélie', 'Laurent', 'Consultant', 'Operations Excellence'],
      ['Bram', 'Janssens', 'Senior Consultant', 'Digital'],
      ['Sofia', 'Romano', 'HR Business Partner', 'Human Resources'],
      ['Daan', 'Willems', 'Finance Manager', 'Finance'],
      ['Lotte', 'Hermans', 'Accountant', 'Finance'],
      ['Mehdi', 'Benali', 'Consultant', 'Digital'],
      ['Hannah', 'Becker', 'Marketing Lead', 'Marketing'],
      ['Ruben', 'Mertens', 'Junior Consultant', 'Strategy'],
      ['Julie', 'Lambert', 'Executive Assistant', 'Management'],
      ['Thomas', 'Wagner', 'Partner', 'Operations Excellence'],
      ['Emma', 'Smith', 'Senior Consultant', 'Strategy'],
      ['Elise', 'Goossens', 'Consultant', 'People & Change'],
      ['Victor', 'Lemaire', 'Senior Consultant', 'Operations Excellence'],
      ['Nina', 'Kowalski', 'Data Analyst', 'Digital'],
      ['Arthur', 'Jacobs', 'Junior Consultant', 'Digital', false],
      ['Laura', 'Fontaine', 'Consultant', 'People & Change'],
      ['Kobe', 'Michiels', 'IT Coordinator', 'Operations'],
      ['Isabel', 'Moreau', 'Partner', 'People & Change'],
      ['Samir', 'El Idrissi', 'Consultant', 'Strategy'],
      ['Femke', 'Van Damme', 'Recruiter', 'Human Resources', false],
      ['Oliver', 'Hughes', 'Senior Consultant', 'Digital'],
      ['Marie', 'Dupont', 'Receptionist', 'Operations'],
    ],
  },
  bp: {
    primary: 'Karel Vos',
    rows: [
      ['Karel', 'Vos', 'Operations Director', 'Management'],
      ['Ingrid', 'Smets', 'Office Manager', 'Administration'],
      ['Wout', 'Aerts', 'Warehouse Supervisor', 'Warehouse', true, 1],
      ['Leen', 'Bogaerts', 'Dispatcher', 'Transport', true, 1],
      ['Hassan', 'Amrani', 'Fleet Planner', 'Transport'],
      ['Eva', 'Lenaerts', 'Finance Officer', 'Finance'],
      ['Stijn', 'Coppens', 'Warehouse Team Lead', 'Warehouse', true, 1],
      ['Anouk', 'De Wit', 'Customer Service Agent', 'Customer Service'],
      ['Marco', 'Rossi', 'Transport Planner', 'Transport'],
      ['Joris', 'Dewulf', 'Inventory Controller', 'Warehouse', false, 1],
    ],
  },
  mt: {
    primary: 'Pim van den Berg',
    rows: [
      ['Pim', 'van den Berg', 'CTO', 'Engineering'],
      ['Sanne', 'de Vries', 'Office Manager', 'Operations'],
      ['Joost', 'Bakker', 'Lead Developer', 'Engineering'],
      ['Fleur', 'Visser', 'DevOps Engineer', 'Engineering'],
      ['Ravi', 'Menon', 'Backend Developer', 'Engineering'],
      ['Lisa', 'Smit', 'Product Manager', 'Product'],
      ['Niels', 'Mulder', 'QA Engineer', 'Engineering'],
      ['Yara', 'Hoekstra', 'Frontend Developer', 'Engineering'],
      ['Bas', 'Kuipers', 'Support Engineer', 'Customer Success'],
      ['Mila', 'Jansen', 'HR & Finance Officer', 'Operations'],
    ],
  },
  hd: {
    primary: 'Katrien Vermeersch',
    rows: [
      ['Annelies', 'Wauters', 'Practice Owner & Dentist', 'Clinical'],
      ['Katrien', 'Vermeersch', 'Practice Manager', 'Administration'],
      ['Jens', 'Lievens', 'Dentist', 'Clinical'],
      ['Ines', 'Martens', 'Dental Hygienist', 'Clinical'],
      ['Lien', 'Desmet', 'Receptionist', 'Front desk'],
      ['Tim', 'Verbeke', 'Dentist', 'Clinical'],
      ['Ella', 'Geerts', 'Dental Assistant', 'Clinical', false],
    ],
  },
  af: {
    primary: 'Helen Alder',
    rows: [
      ['Helen', 'Alder', 'Managing Partner', 'Partners'],
      ['Daniel', 'Finch', 'Partner', 'Partners'],
      ['Sophie', 'van Leeuwen', 'Associate', 'Corporate Law'],
      ['Ruud', 'Hendriks', 'Associate', 'Employment Law'],
      ['Anna', 'Kramer', 'Paralegal', 'Corporate Law'],
      ['Mark', 'de Boer', 'Office Manager', 'Operations'],
      ['Eline', 'Vos', 'Legal Secretary', 'Operations'],
      ['Tess', 'Brouwer', 'Trainee Lawyer', 'Corporate Law', false],
    ],
  },
  cl: {
    primary: 'Gilles Renard',
    rows: [
      ['Gilles', 'Renard', 'Founding Architect', 'Management'],
      ['Marieke', 'Smeets', 'Studio Manager', 'Operations'],
    ],
  },
};

const SERVICES = [
  { name: 'Managed Workstation', description: 'Monitoring, patching, endpoint protection and helpdesk per device', unitPrice: 45, unitCost: 18 },
  { name: 'Managed Server', description: 'Monitoring, patching and backup supervision per server', unitPrice: 150, unitCost: 60 },
  { name: 'Microsoft 365 Management', description: 'Tenant administration, licence management and security baseline per user', unitPrice: 6, unitCost: 1.5 },
  { name: 'Backup & Disaster Recovery', description: 'Image backups, offsite replication and quarterly restore tests', unitPrice: 250, unitCost: 90 },
  { name: 'Managed Firewall', description: 'Firmware, rule reviews and VPN management per firewall', unitPrice: 55, unitCost: 20 },
];

/* ------------------------------------------------------------------- KB */

interface KbSpec {
  key: string;
  title: string;
  category: string | null;
  company?: CoKey;
  tags: string[];
  visibility: 'internal' | 'public';
  status: 'published' | 'draft';
  author: UserKey;
  daysAgo: number;
  body: string[];
}

const KB: KbSpec[] = [
  {
    key: 'outlook-profile',
    title: 'Reset an Outlook profile',
    category: 'Microsoft 365',
    tags: ['outlook', 'microsoft-365', 'profile'],
    visibility: 'public',
    status: 'published',
    author: 'noor',
    daysAgo: 120,
    body: [
      '## When to use',
      'Outlook keeps prompting for a password, hangs on "Loading profile" or shows an empty mailbox while Outlook on the web works fine.',
      '',
      '## Steps',
      '1. Close Outlook and Teams.',
      '2. Open **Control Panel → Mail (Microsoft Outlook) → Show Profiles**.',
      '3. Click **Add…**, name the profile `Outlook-new` and sign in with the user\'s work account.',
      '4. Select **Always use this profile** and choose `Outlook-new`.',
      '5. Start Outlook and wait for the initial sync (large mailboxes may take 30+ minutes on cached mode).',
      '6. When everything works, remove the old profile.',
      '',
      '## If prompts continue',
      '- Clear `MicrosoftOffice16_Data:*` entries in **Credential Manager → Windows Credentials**.',
      '- Check **Settings → Accounts → Access work or school** for a stale account and reconnect it.',
      '',
      '> Do not delete the OST manually while Outlook is running.',
    ],
  },
  {
    key: 'onboarding',
    title: 'Onboard a new Microsoft 365 user',
    category: 'Procedures',
    tags: ['onboarding', 'microsoft-365', 'checklist'],
    visibility: 'internal',
    status: 'published',
    author: 'sarah',
    daysAgo: 200,
    body: [
      '## Before the start date',
      '- [ ] Confirm name, job title, department, manager and start date with the customer contact.',
      '- [ ] Create the user in Entra ID (or on-prem AD when the tenant is synced) using the naming convention `first.last`.',
      '- [ ] Assign the licence group from the customer\'s documentation article (never assign licences directly).',
      '- [ ] Add to department security groups, Teams and shared mailboxes.',
      '- [ ] Prepare the device: Autopilot / reimage, BitLocker escrow verified, RMM + Action1 agent online.',
      '- [ ] Register the device as a CI and link it to the new contact.',
      '',
      '## On day one',
      '- [ ] Walk the user through MFA registration (Authenticator app).',
      '- [ ] Verify Outlook, Teams, OneDrive Known Folder Move and printer access.',
      '- [ ] Log time against the onboarding ticket and close it with a public summary.',
    ],
  },
  {
    key: 'offboarding',
    title: 'Offboard a departing user',
    category: 'Procedures',
    tags: ['offboarding', 'security', 'checklist'],
    visibility: 'internal',
    status: 'published',
    author: 'sarah',
    daysAgo: 190,
    body: [
      '## Same day as departure',
      '1. Block sign-in and revoke all sessions in Entra ID.',
      '2. Reset the password and remove MFA methods.',
      '3. Convert the mailbox to a shared mailbox and grant the manager access (if requested in writing).',
      '4. Remove licences once the mailbox conversion has completed.',
      '5. Transfer OneDrive ownership to the manager (retention: 30 days).',
      '',
      '## Device',
      '- Collect the laptop, wipe it via Intune / reimage, and set the CI lifecycle to **In stock** or **Retired**.',
      '- Unlink the CI from the contact and mark the contact inactive.',
    ],
  },
  {
    key: 'forticlient',
    title: 'Configure FortiClient VPN',
    category: 'Networking',
    tags: ['vpn', 'forticlient', 'remote-work'],
    visibility: 'public',
    status: 'published',
    author: 'lucas',
    daysAgo: 160,
    body: [
      '## Install',
      'FortiClient VPN is deployed automatically to managed laptops. If it is missing, install it from Company Portal.',
      '',
      '## Configure the connection',
      '1. Open FortiClient and choose **Configure VPN**.',
      '2. Select **SSL-VPN**, connection name `Office`.',
      '3. Remote gateway: the hostname from your company documentation article (e.g. `vpn.northstar-consulting.example`), port `443`.',
      '4. Enable **Single Sign-On (SSO) for VPN Tunnel** and save.',
      '5. Click **SAML Login** and sign in with your work account + MFA.',
      '',
      '## Troubleshooting',
      '- *"Unable to establish the VPN connection (-14)"*: the hotel/guest Wi-Fi blocks the connection; try a mobile hotspot.',
      '- Stuck at 40%: reboot, then check that no other VPN client is installed.',
      '- Internal file shares unreachable but VPN connected: run `ipconfig /flushdns`.',
    ],
  },
  {
    key: 'printer-drivers',
    title: 'Printer driver deployment',
    category: 'Endpoints',
    tags: ['printers', 'intune', 'drivers'],
    visibility: 'internal',
    status: 'published',
    author: 'tom',
    daysAgo: 140,
    body: [
      '## Standard approach',
      'Use **Universal Print** where the customer has Business Premium; otherwise deploy the vendor universal driver as a Win32 app.',
      '',
      '1. Download the vendor universal PCL6 driver package and extract it.',
      '2. Package with the install script (`pnputil /add-driver *.inf /install`, then `Add-PrinterDriver`).',
      '3. Create the printer with `Add-PrinterPort` + `Add-Printer` in a second script (per site).',
      '4. Assign to the device group of the site; detection rule = printer name exists.',
      '',
      '## Notes',
      '- Never deploy model-specific drivers from Windows Update for MFPs; scan-to-folder breaks after updates.',
      '- Document the printer IP and queue name on the printer CI.',
    ],
  },
  {
    key: 'backup-checklist',
    title: 'Backup verification checklist',
    category: 'Procedures',
    tags: ['backup', 'checklist', 'monthly'],
    visibility: 'internal',
    status: 'published',
    author: 'lucas',
    daysAgo: 230,
    body: [
      '## Daily (automated alert review)',
      '- [ ] All backup jobs completed in the last 24 h (alerts create tickets in **Monitoring Alerts**).',
      '- [ ] Offsite replication lag below 24 h.',
      '',
      '## Monthly',
      '- [ ] File-level restore test of 3 random files per server; record the result in the ticket.',
      '- [ ] Verify retention matches the contract (30 daily / 12 monthly).',
      '- [ ] Check NAS volume health and free space (> 20 %).',
      '',
      '## Quarterly',
      '- [ ] Full VM restore test into an isolated network; time the restore (RTO evidence).',
      '- [ ] Review the backup scope with the customer when new servers or shares appear.',
    ],
  },
  {
    key: 'phishing',
    title: 'Responding to a reported phishing email',
    category: 'Security',
    tags: ['security', 'phishing', 'incident-response'],
    visibility: 'internal',
    status: 'published',
    author: 'lucas',
    daysAgo: 100,
    body: [
      '1. Ask the reporter **not** to click anything and to use the *Report* button in Outlook.',
      '2. Run a message trace for the sender / subject over the last 7 days.',
      '3. Purge the message from all mailboxes (Defender → Explorer → *Soft delete*).',
      '4. Block the sender domain and URLs in the tenant allow/block list.',
      '5. Check sign-in logs of every recipient who clicked (risky sign-ins, new MFA methods, inbox rules).',
      '6. If credentials were entered: reset password, revoke sessions, review mailbox rules and forwarding.',
      '7. Document recipients and actions in the ticket; send a short awareness note to the customer contact.',
    ],
  },
  {
    key: 'mfa',
    title: 'Re-register MFA after a phone change',
    category: 'Security',
    tags: ['mfa', 'authenticator', 'microsoft-365'],
    visibility: 'public',
    status: 'published',
    author: 'noor',
    daysAgo: 90,
    body: [
      '## For technicians',
      '1. Verify the caller\'s identity by calling back the number in Taskora or via their manager.',
      '2. In Entra ID → Users → Authentication methods, **Require re-register MFA** (or issue a Temporary Access Pass).',
      '3. Ask the user to browse to `https://aka.ms/mysignins` and add Microsoft Authenticator.',
      '',
      '## For users',
      'Install Microsoft Authenticator on your new phone **before** wiping the old one. Then sign in at *My Sign-Ins → Security info → Add sign-in method*.',
    ],
  },
  {
    key: 'disk-space',
    title: 'Free up disk space on a Windows laptop',
    category: 'Endpoints',
    tags: ['windows', 'performance', 'disk'],
    visibility: 'internal',
    status: 'draft',
    author: 'lucas',
    daysAgo: 6,
    body: [
      '> Draft — to be reviewed by Sarah.',
      '',
      '1. Check usage with `Get-PSDrive C` and WizTree (portable, from the tools share).',
      '2. Run **Disk Cleanup → Clean up system files** (Windows Update cleanup is often 5–10 GB).',
      '3. Set OneDrive to **Free up space** for large project folders (Files On-Demand).',
      '4. Clear Teams cache (`%appdata%\\Microsoft\\Teams` / new Teams: reset from Settings → Apps).',
      '5. If still > 85 % used, propose an SSD upgrade or a replacement (check the warranty on the CI first).',
    ],
  },
  {
    key: 'teams-av',
    title: 'Troubleshoot Teams audio and video',
    category: 'Microsoft 365',
    tags: ['teams', 'audio', 'video'],
    visibility: 'public',
    status: 'draft',
    author: 'noor',
    daysAgo: 12,
    body: [
      '- Check **Settings → Devices** in Teams: the correct headset and camera are selected.',
      '- Make a test call (*Settings → Devices → Make a test call*).',
      '- On Wi-Fi: prefer the 5 GHz network and move closer to an access point.',
      '- Close other apps using the camera (browser tabs, other meeting clients).',
      '- Update the docking station firmware when USB headsets drop out repeatedly.',
    ],
  },
  {
    key: 'ns-overview',
    title: 'Northstar Consulting — network & server overview',
    category: null,
    company: 'ns',
    tags: ['documentation', 'network', 'servers'],
    visibility: 'internal',
    status: 'published',
    author: 'lucas',
    daysAgo: 150,
    body: [
      '## Network',
      '- Firewall **NS-FW-01** (FortiGate 60F) — WAN 1 fibre, WAN 2 4G failover. SSL-VPN `vpn.northstar-consulting.example`.',
      '- Core switches **NS-SW-01/02** (stacked), VLAN 10 data, 20 voice, 30 guest, 99 management.',
      '- 3 × UniFi access points; guest SSID isolated.',
      '',
      '## Servers',
      '- **NS-HV-01** Hyper-V host → VMs NS-DC01 (AD/DNS/DHCP), NS-FS01 (file shares, being migrated to SharePoint), NS-APP01 (time-tracking app).',
      '- Backups to **NS-NAS-01** nightly, replicated offsite weekly.',
      '',
      '## Contacts',
      'Primary: Charlotte Dubois (Office Manager). Escalations / approvals: Pieter Claes.',
    ],
  },
  {
    key: 'bp-runbook',
    title: 'BluePeak Logistics — warehouse scanners & WMS runbook',
    category: null,
    company: 'bp',
    tags: ['documentation', 'warehouse', 'wms', 'wifi'],
    visibility: 'internal',
    status: 'published',
    author: 'tom',
    daysAgo: 110,
    body: [
      '## Warehouse management system (WMS)',
      '- Runs on **BP-WMS01** (VM on BP-HV-01). Service `WmsAppHost` must be running; restart only after 18:00 or with Karel Vos\' approval.',
      '- Database maintenance job runs Sunday 02:00.',
      '',
      '## Handheld scanners',
      '- SSID `BP-SCAN` (WPA2-PSK, 2.4 GHz only — legacy scanners). PSK in the password vault.',
      '- Known dead zones: aisles 7–12 near the cold store. Wi-Fi refresh project planned.',
      '',
      '## Label printers',
      'Zebra ZT411 (**BP-PRN-01**) at the loading dock — blank labels usually means the media sensor needs recalibration (hold *Pause + Cancel* 2 s).',
    ],
  },
];

/* ---------------------------------------------------------------- tickets */

interface TicketSpec {
  key?: string;
  co: CoKey;
  title: string;
  desc: string;
  type: string;
  issue?: string;
  sub?: string;
  prio: Prio;
  source: string;
  queue?: string;
  contact?: string | null;
  /** CI name, 'device' (contact's assigned device) or a role picked from the company fleet. */
  ci?: string;
  days: number;
  hour?: number;
  minute?: number;
  outcome: Outcome;
  tech?: UserKey | null;
  steps?: string[];
  ask?: string;
  vendor?: string;
  schedule?: string;
  escalate?: string;
  resolution?: string;
  tags?: string[];
  slow?: boolean;
  project?: 'm365' | 'srv2016';
  watchers?: UserKey[];
  relate?: { key: string; type: 'related' | 'duplicate_of' | 'caused_by' };
  kb?: string[];
  onsite?: boolean;
  internal?: boolean;
}

const TICKETS: TicketSpec[] = [
  {
    key: 'emma-slow',
    co: 'ns',
    title: 'Laptop running slowly',
    desc: 'Emma reports that her laptop has become very slow over the last week: Outlook and Teams take minutes to open and the fan runs constantly. She has client workshops tomorrow and needs it fixed today.',
    type: 'Incident',
    issue: 'Hardware',
    sub: 'Laptop',
    prio: 'High',
    source: 'Phone',
    contact: 'Emma Smith',
    ci: 'NS-LAPTOP-014',
    days: 0.9,
    hour: 9,
    outcome: 'in_progress',
    tech: 'lucas',
    steps: [
      'Remote session: CPU at 95–100 % with a Defender full scan and OneDrive syncing ~48k files at the same time. C: drive 92 % full (468/512 GB).',
      'Action1 shows 2 missing critical updates and a pending reboot (uptime 23 days). Agreed with Emma to reboot at 12:30 and to free up space afterwards.',
    ],
    tags: ['performance', 'vip'],
    slow: false,
    watchers: ['sarah'],
    kb: ['disk-space'],
  },
  {
    key: 'outlook-prompt',
    co: 'ns',
    title: 'Outlook keeps asking for password',
    desc: 'Since changing my password yesterday Outlook keeps showing the sign-in window every few minutes. Webmail works.',
    type: 'Incident',
    issue: 'Microsoft 365',
    sub: 'Outlook',
    prio: 'Medium',
    source: 'Email',
    contact: 'Jonas Wouters',
    ci: 'device',
    days: 3.2,
    outcome: 'resolved',
    tech: 'noor',
    steps: [
      'Credential prompt loop after the password change. Cleared MicrosoftOffice16_Data entries from Credential Manager.',
      'Removed the stale work account under Access work or school and re-added it; Outlook signed in once and stayed connected.',
    ],
    resolution: 'Cached credentials from before your password change were still stored on the laptop. We cleared them and reconnected your work account, so Outlook no longer prompts.',
    kb: ['outlook-profile'],
  },
  {
    key: 'ns-onboarding',
    co: 'ns',
    title: 'New user onboarding: Clara Nowak (Consultant, starts Monday)',
    desc: 'Please prepare an account and laptop for Clara Nowak, Consultant in the Strategy team, starting next Monday. Same access as Jonas Wouters.',
    type: 'Service Request',
    issue: 'User Management',
    sub: 'New User Onboarding',
    prio: 'Medium',
    source: 'Portal',
    contact: 'Charlotte Dubois',
    ci: 'NS-LAPTOP-018',
    days: 5.5,
    outcome: 'scheduled',
    tech: 'noor',
    steps: [
      'Account clara.nowak created, Business Premium licence assigned via group, added to Strategy Team and shared mailbox projects@.',
      'NS-LAPTOP-018 (in stock) reimaged with Autopilot; Action1 and RMM agents online, BitLocker key escrowed.',
    ],
    schedule: 'Everything is ready for Clara. I will be on site on her first morning at 09:00 to hand over the laptop and set up MFA with her.',
    kb: ['onboarding'],
  },
  {
    co: 'ns',
    title: 'Teams calls dropping during client meetings',
    desc: 'My Teams calls drop or freeze several times per meeting when I work from the office. Colleagues do not seem to have this problem.',
    type: 'Incident',
    issue: 'Microsoft 365',
    sub: 'Teams',
    prio: 'Medium',
    source: 'Phone',
    contact: 'Bram Janssens',
    ci: 'device',
    days: 12,
    outcome: 'closed',
    tech: 'noor',
    steps: [
      'Call quality dashboard shows high jitter / packet loss only on Wi-Fi. Laptop is connected to the 2.4 GHz band at -74 dBm.',
      'Set the Intel AX211 preferred band to 5 GHz and updated the driver to the latest OEM version.',
    ],
    resolution: 'Your laptop preferred the slower 2.4 GHz Wi-Fi band. We switched it to 5 GHz and updated the Wi-Fi driver; the test calls were stable.',
  },
  {
    co: 'ns',
    title: "Printer on 2nd floor shows 'Offline'",
    desc: 'The big printer on the second floor shows as offline for everyone.',
    type: 'Incident',
    issue: 'Hardware',
    sub: 'Printer',
    prio: 'Low',
    source: 'Phone',
    contact: 'Marie Dupont',
    ci: 'NS-PRN-01',
    days: 20,
    outcome: 'closed',
    tech: 'noor',
    steps: ['Printer received a new DHCP address after a power cut (reservation missing). Added a DHCP reservation for the printer MAC on NS-DC01.'],
    resolution: 'The printer had picked up a new network address after the power cut. We reserved its address so this does not happen again; printing works for everyone.',
    kb: ['printer-drivers'],
  },
  {
    co: 'ns',
    title: 'Shared mailbox access for Finance',
    desc: 'Please give Lotte Hermans full access and send-as rights on finance@northstar-consulting.example.',
    type: 'Service Request',
    issue: 'Microsoft 365',
    sub: 'Exchange Online',
    prio: 'Low',
    source: 'Email',
    contact: 'Daan Willems',
    days: 15,
    outcome: 'closed',
    tech: 'noor',
    steps: ['Approval received from Daan (Finance Manager). Granted FullAccess + SendAs; automapping enabled.'],
    resolution: 'Lotte now has full access and send-as permission on the finance mailbox. It will appear in Outlook automatically within an hour.',
  },
  {
    key: 'ns-phishing',
    co: 'ns',
    title: 'Phishing email reported: "Review shared document"',
    desc: 'Several colleagues received an email asking to review a shared document with a sign-in link. I did not click it.',
    type: 'Incident',
    issue: 'Security',
    sub: 'Phishing',
    prio: 'High',
    source: 'Email',
    contact: 'Hannah Becker',
    days: 7,
    outcome: 'closed',
    tech: 'lucas',
    steps: [
      'Message trace: 14 recipients, sender domain registered 2 days ago. Purged all copies with Defender Explorer (soft delete).',
      'Blocked sender domain and URL. Sign-in logs of the 2 users who opened the mail show no risky sign-ins and no new MFA methods.',
    ],
    resolution: 'The phishing email was removed from all 14 mailboxes and the sender is blocked. Nobody entered credentials. Thanks for reporting it quickly!',
    tags: ['security', 'phishing'],
    kb: ['phishing'],
  },
  {
    key: 'ns-vpn',
    co: 'ns',
    title: 'VPN not connecting from home',
    desc: 'FortiClient stops at 40 % when I try to connect from home. It worked last week.',
    type: 'Incident',
    issue: 'Network',
    sub: 'VPN',
    prio: 'Medium',
    source: 'Phone',
    contact: 'Victor Lemaire',
    ci: 'device',
    days: 4.2,
    outcome: 'waiting_customer',
    tech: 'lucas',
    steps: ['FortiGate logs show no SSL-VPN attempts from Victor\'s account since Friday — connection is likely blocked before reaching the firewall.'],
    ask: 'Could you send us a screenshot of the FortiClient error and let us know which internet connection you are using at home? A quick test via your phone\'s hotspot would also help.',
    kb: ['forticlient'],
  },
  {
    co: 'ns',
    title: 'Disk space below 10 % on NS-FS01 (D:)',
    desc: 'Monitoring alert: volume D: on NS-FS01 has 8.7 % free space (threshold 10 %).',
    type: 'Alert',
    issue: 'Server',
    sub: 'Storage',
    prio: 'High',
    source: 'Monitoring Alert',
    queue: 'Monitoring Alerts',
    ci: 'NS-FS01',
    days: 5,
    outcome: 'resolved',
    tech: 'lucas',
    steps: ['TreeSize: 140 GB of duplicate project exports in \\\\NS-FS01\\Clients\\_Archive. Confirmed with Charlotte they are already in SharePoint (migration project).'],
    resolution: 'Moved the archive exports to cold storage on NS-NAS-01 and extended D: by 100 GB. Free space now 31 %.',
    tags: ['monitoring'],
  },
  {
    co: 'ns',
    title: "OneDrive not syncing 'Client Projects' library",
    desc: 'OneDrive shows a red cross on the Client Projects folder and my latest files are not online.',
    type: 'Incident',
    issue: 'Microsoft 365',
    sub: 'SharePoint / OneDrive',
    prio: 'Medium',
    source: 'Portal',
    contact: 'Amélie Laurent',
    ci: 'device',
    days: 2.1,
    outcome: 'in_progress',
    tech: 'noor',
    steps: ['Sync error: path too long (> 400 chars) on 37 files in nested client folders. Shared the list with Amélie to shorten folder names.'],
  },
  {
    co: 'ns',
    title: 'Request: Adobe Acrobat Pro licence',
    desc: 'I need to edit and sign PDFs for client proposals. Can I get Acrobat Pro?',
    type: 'Service Request',
    issue: 'Software',
    sub: 'Installation',
    prio: 'Low',
    source: 'Portal',
    contact: 'Elise Goossens',
    ci: 'device',
    days: 10,
    outcome: 'closed',
    tech: 'noor',
    steps: ['Approved by Charlotte. Assigned a spare Acrobat Pro seat from the Northstar VIP admin console and deployed via Company Portal.'],
    resolution: 'Acrobat Pro is installed and licensed on your laptop. Sign in with your work account the first time you open it.',
  },
  {
    key: 'ns-sharepoint-migration',
    co: 'ns',
    title: "Migrate shared drive 'Q:\\Clients' to SharePoint",
    desc: 'Project work package: migrate the Clients share from NS-FS01 to the new Client Projects SharePoint site, including permissions mapping.',
    type: 'Service Request',
    issue: 'Microsoft 365',
    sub: 'SharePoint / OneDrive',
    prio: 'Medium',
    source: 'Internal',
    queue: 'Projects',
    ci: 'NS-FS01',
    days: 8,
    outcome: 'in_progress',
    tech: 'tom',
    project: 'm365',
    steps: [
      'Pre-scan with the migration tool: 212 GB, 186k files, 41 items with unsupported characters. Exported permission report.',
      'First incremental pass completed overnight (92 %). Remaining: 2 folders with broken inheritance — waiting on Charlotte to confirm owners.',
    ],
  },
  {
    co: 'ns',
    title: 'Laptop screen flickering',
    desc: 'The screen of my laptop flickers and sometimes goes black when I move the lid.',
    type: 'Incident',
    issue: 'Hardware',
    sub: 'Laptop',
    prio: 'Medium',
    source: 'Phone',
    contact: 'Ruben Mertens',
    ci: 'NS-LAPTOP-011',
    days: 6,
    outcome: 'waiting_vendor',
    tech: 'lucas',
    steps: ['Reproduced with external monitor working fine — internal panel / display cable fault. Device is under Dell ProSupport.'],
    vendor: 'Opened Dell ProSupport case (demo ref DS-0000-4711). Onsite engineer will replace the display assembly; awaiting the part dispatch confirmation.',
  },
  {
    co: 'ns',
    title: 'User offboarding: Femke Van Damme',
    desc: 'Femke Van Damme (Recruiter) leaves us on Friday. Please disable her account and forward her mailbox to Sofia.',
    type: 'Service Request',
    issue: 'User Management',
    sub: 'User Offboarding',
    prio: 'Medium',
    source: 'Email',
    contact: 'Sofia Romano',
    days: 31,
    outcome: 'closed',
    tech: 'noor',
    steps: ['Sign-in blocked, sessions revoked, mailbox converted to shared and Sofia granted access. Licence removed.', 'NS-LAPTOP-023 collected and wiped; CI set to retired (battery swollen).'],
    resolution: "Femke's account is disabled, Sofia has access to her mailbox and OneDrive, and the laptop has been wiped and retired.",
    kb: ['offboarding'],
  },
  {
    co: 'ns',
    title: 'FortiGate firmware update (FortiOS 7.4 patch)',
    desc: 'Planned change: apply the latest FortiOS 7.4 patch release to NS-FW-01 during the maintenance window (Tuesday 19:00).',
    type: 'Change Request',
    issue: 'Network',
    sub: 'Firewall',
    prio: 'Medium',
    source: 'Internal',
    ci: 'NS-FW-01',
    days: 18,
    outcome: 'closed',
    tech: 'lucas',
    steps: ['Config backup taken, release notes reviewed (no breaking changes for SSL-VPN). Upgrade completed in 11 minutes, VPN and VLANs tested.'],
    resolution: 'Firmware updated successfully during the maintenance window; VPN, Wi-Fi and internet were tested afterwards.',
    internal: true,
  },
  {
    key: 'ns-mfa',
    co: 'ns',
    title: 'MFA prompts not arriving on new phone',
    desc: 'I got a new phone this weekend and the Authenticator approvals no longer arrive. I cannot sign in to Teams.',
    type: 'Service Request',
    issue: 'User Management',
    sub: 'Password Reset',
    prio: 'Medium',
    source: 'Phone',
    contact: 'Thomas Wagner',
    days: 0.12,
    outcome: 'new',
    tech: null,
    kb: ['mfa'],
  },
  {
    key: 'ns-internet',
    co: 'ns',
    title: 'Whole office: internet very slow / dropping',
    desc: 'Nobody in the office can work properly — websites time out and Teams calls drop.',
    type: 'Incident',
    issue: 'Network',
    sub: 'Internet Connectivity',
    prio: 'Critical',
    source: 'Phone',
    contact: 'Charlotte Dubois',
    ci: 'NS-FW-01',
    days: 22,
    hour: 10,
    minute: 5,
    outcome: 'closed',
    tech: 'lucas',
    steps: [
      'WAN1 (fibre) shows 40 % packet loss upstream of the modem. ISP status page reports a regional incident (demo).',
      'Forced failover to WAN2 (4G) via SD-WAN rule; Teams traffic prioritised. Users can work again with reduced bandwidth.',
    ],
    resolution: 'Your internet provider had a regional outage. We switched the office to the 4G backup line until the fibre was repaired (14:20) and then switched back.',
    tags: ['outage'],
    watchers: ['sarah'],
  },
  {
    key: 'ns-internet-dup',
    co: 'ns',
    title: 'Internet down?',
    desc: 'Is the internet down? I cannot open anything.',
    type: 'Incident',
    issue: 'Network',
    sub: 'Internet Connectivity',
    prio: 'High',
    source: 'Email',
    contact: 'Julie Lambert',
    days: 22,
    hour: 10,
    minute: 18,
    outcome: 'closed',
    tech: 'lucas',
    resolution: 'Duplicate of the office-wide internet incident, which has been resolved.',
    relate: { key: 'ns-internet', type: 'duplicate_of' },
  },
  {
    co: 'ns',
    title: 'Excel crashes when opening macro workbook',
    desc: 'Excel closes immediately when I open the budgeting workbook with macros. Other files open fine.',
    type: 'Incident',
    issue: 'Software',
    sub: 'Application Error',
    prio: 'Medium',
    source: 'Email',
    contact: 'Daan Willems',
    ci: 'device',
    days: 0.6,
    outcome: 'new',
    tech: 'noor',
  },
  {
    co: 'ns',
    title: 'Request second monitor for home office',
    desc: 'Could I get a second monitor for my home office? My manager approved it.',
    type: 'Service Request',
    issue: 'Hardware',
    sub: 'Peripheral',
    prio: 'Low',
    source: 'Portal',
    contact: 'Laura Fontaine',
    days: 14,
    outcome: 'closed',
    tech: 'tom',
    steps: ['Ordered a 27" USB-C monitor from stock; delivered to the office for pick-up.'],
    resolution: 'Your monitor is ready for pick-up at reception. It connects with a single USB-C cable.',
  },
  /* ------------------------------------------------------------ BluePeak */
  {
    key: 'bp-scanners',
    co: 'bp',
    title: 'Handheld scanners losing Wi-Fi in aisles 7–12',
    desc: 'Our pickers keep losing connection in aisles 7 to 12. Scans are lost and orders are delayed.',
    type: 'Incident',
    issue: 'Network',
    sub: 'Wi-Fi',
    prio: 'High',
    source: 'Phone',
    contact: 'Wout Aerts',
    ci: 'BP-AP-03',
    days: 3,
    outcome: 'escalated',
    tech: 'noor',
    steps: ['Controller shows BP-AP-03 with 38 clients and frequent roaming failures; channel utilisation 85 % on 2.4 GHz. Restarted the AP — temporary improvement only.'],
    escalate: 'Escalating to Level 2: coverage gap + legacy APs (end of life). Linked to the planned Wi-Fi refresh; need an interim fix (extra AP / channel plan).',
    tags: ['wifi', 'warehouse'],
    watchers: ['tom'],
    onsite: true,
  },
  {
    key: 'bp-dock',
    co: 'bp',
    title: 'Scanners disconnect at loading dock',
    desc: 'The scanners at the loading dock disconnect when trucks are parked in front of door 3.',
    type: 'Incident',
    issue: 'Network',
    sub: 'Wi-Fi',
    prio: 'Medium',
    source: 'Phone',
    contact: 'Stijn Coppens',
    days: 26,
    outcome: 'closed',
    tech: 'noor',
    steps: ['Signal drops to -82 dBm behind trailers. Raised AP-04 transmit power and moved the dock scanners to a fixed channel.'],
    resolution: 'We increased the Wi-Fi power near the loading dock. A permanent fix is part of the upcoming Wi-Fi refresh.',
    relate: { key: 'bp-scanners', type: 'related' },
  },
  {
    co: 'bp',
    title: 'WMS application slow for all users',
    desc: 'The warehouse management system is extremely slow for everyone since this morning.',
    type: 'Incident',
    issue: 'Server',
    sub: 'Performance',
    prio: 'Critical',
    source: 'Phone',
    contact: 'Karel Vos',
    ci: 'BP-WMS01',
    days: 11,
    outcome: 'closed',
    tech: 'lucas',
    steps: [
      'BP-WMS01: SQL Server using 98 % memory, a reindex job started at 07:00 instead of Sunday 02:00 (schedule changed by vendor update).',
      'Stopped the job with Karel\'s approval and restored the original schedule. Response times back to normal.',
    ],
    resolution: 'A maintenance job was accidentally scheduled during working hours after a vendor update. We stopped it and restored the weekend schedule.',
    watchers: ['sarah', 'tom'],
    kb: ['bp-runbook'],
  },
  {
    co: 'bp',
    title: 'Label printer prints blank labels',
    desc: 'The Zebra printer at the dock feeds labels but nothing is printed on them.',
    type: 'Incident',
    issue: 'Hardware',
    sub: 'Printer',
    prio: 'High',
    source: 'Phone',
    contact: 'Leen Bogaerts',
    ci: 'BP-PRN-01',
    days: 1.1,
    outcome: 'in_progress',
    tech: 'noor',
    steps: ['Media sensor recalibrated remotely via the web UI — still blank. Suspect worn printhead or wrong ribbon side; asked Leen for a photo of the ribbon.'],
    kb: ['bp-runbook'],
  },
  {
    co: 'bp',
    title: 'New user onboarding: 3 seasonal warehouse staff',
    desc: 'Three seasonal workers start on the 1st. They need scanner logins and a shared mailbox, no laptops.',
    type: 'Service Request',
    issue: 'User Management',
    sub: 'New User Onboarding',
    prio: 'Medium',
    source: 'Email',
    contact: 'Ingrid Smets',
    days: 19,
    outcome: 'closed',
    tech: 'noor',
    steps: ['Created 3 F3-licensed accounts with expiry date, added to Warehouse-Seasonal group and WMS scanner role.'],
    resolution: 'The three seasonal accounts are ready; credentials were handed to Ingrid in a sealed envelope. Accounts expire automatically at the end of the season.',
    kb: ['onboarding'],
  },
  {
    key: 'bp-backup',
    co: 'bp',
    title: 'Backup job failed: BP-HV-01 nightly image',
    desc: 'Monitoring alert: nightly image backup of BP-HV-01 failed (VSS snapshot timeout).',
    type: 'Alert',
    issue: 'Server',
    sub: 'Backup',
    prio: 'High',
    source: 'Monitoring Alert',
    queue: 'Monitoring Alerts',
    ci: 'BP-HV-01',
    days: 0.3,
    outcome: 'new',
    tech: null,
    tags: ['monitoring', 'backup'],
    kb: ['backup-checklist'],
  },
  {
    co: 'bp',
    title: 'Password reset for Hassan Amrani',
    desc: 'Hassan is locked out of his account.',
    type: 'Service Request',
    issue: 'User Management',
    sub: 'Password Reset',
    prio: 'Low',
    source: 'Phone',
    contact: 'Hassan Amrani',
    days: 9,
    outcome: 'closed',
    tech: 'noor',
    steps: ['Identity verified by call-back. Account unlocked, temporary password issued.'],
    resolution: 'Your account is unlocked and you have set a new password. Remember the self-service reset at aka.ms/sspr.',
  },
  {
    co: 'bp',
    title: 'Mechelen site VPN tunnel flapping',
    desc: 'Monitoring: the site-to-site tunnel between Antwerp and Mechelen went down 6 times in the last hour.',
    type: 'Incident',
    issue: 'Network',
    sub: 'Firewall',
    prio: 'High',
    source: 'Monitoring Alert',
    queue: 'Level 2 Support',
    ci: 'BP-FW-02',
    days: 13,
    outcome: 'closed',
    tech: 'lucas',
    steps: ['IKE logs: DPD timeouts. ISP at Mechelen changed the public IP (dynamic). Switched the tunnel to FQDN-based peer with DDNS.'],
    resolution: 'The Mechelen internet line received a new public IP. We switched the tunnel to a hostname-based configuration so it survives future IP changes.',
  },
  {
    key: 'bp-quote',
    co: 'bp',
    title: 'Quote request: replacement for BP-HV-01 (warranty ending)',
    desc: 'You told us the warranty of our main server ends soon. Please send us options.',
    type: 'Service Request',
    issue: 'Server',
    sub: 'Performance',
    prio: 'Low',
    source: 'Email',
    contact: 'Karel Vos',
    ci: 'BP-HV-01',
    days: 4,
    outcome: 'waiting_customer',
    tech: 'sarah',
    steps: ['Prepared two options: 3-year warranty extension vs. new host with Server 2025 licensing. Sent via the CRM opportunity.'],
    ask: 'We sent you two options (warranty extension or replacement). Could you let us know which one you prefer so we can order before the warranty ends?',
  },
  {
    co: 'bp',
    title: 'Outlook calendar not showing shared calendars',
    desc: 'I no longer see the transport planning calendar in Outlook.',
    type: 'Incident',
    issue: 'Microsoft 365',
    sub: 'Outlook',
    prio: 'Low',
    source: 'Portal',
    contact: 'Anouk De Wit',
    ci: 'device',
    days: 8,
    outcome: 'closed',
    tech: 'noor',
    steps: ['Shared calendar improvements setting caused a stale cache; removed and re-added the calendar.'],
    resolution: 'The shared calendar is visible again after we re-added it to your Outlook.',
    kb: ['outlook-profile'],
  },
  /* ------------------------------------------------------------ Meridian */
  {
    co: 'mt',
    title: 'Build agent MT-BUILD01 out of disk space',
    desc: 'CI pipelines fail with "No space left on device" on the self-hosted build agent.',
    type: 'Incident',
    issue: 'Server',
    sub: 'Storage',
    prio: 'High',
    source: 'Email',
    contact: 'Fleur Visser',
    ci: 'MT-BUILD01',
    days: 2.5,
    outcome: 'resolved',
    tech: 'lucas',
    steps: ['/var/lib/docker at 100 %: 180 GB of dangling images and build cache. Ran docker system prune with Fleur\'s approval.', 'Added a weekly cron to prune images older than 7 days and a 85 % disk alert.'],
    resolution: 'The build agent disk was full of old Docker images. We cleaned it up and added an automatic weekly cleanup plus an early-warning alert.',
  },
  {
    co: 'mt',
    title: "MacBook won't connect to office Wi-Fi after macOS update",
    desc: 'After updating macOS my MacBook says "incorrect password" for the office Wi-Fi.',
    type: 'Incident',
    issue: 'Network',
    sub: 'Wi-Fi',
    prio: 'Medium',
    source: 'Chat',
    contact: 'Yara Hoekstra',
    ci: 'MT-MBP-04',
    days: 5,
    outcome: 'resolved',
    tech: 'noor',
    steps: ['802.1X profile certificate not trusted after the update. Re-pushed the Wi-Fi configuration profile.'],
    resolution: 'We re-installed the Wi-Fi configuration profile on your MacBook; it connects automatically again.',
  },
  {
    co: 'mt',
    title: 'Request admin rights to install Docker Desktop',
    desc: 'I need Docker Desktop for local development. Can I get admin rights or can you install it?',
    type: 'Service Request',
    issue: 'Software',
    sub: 'Installation',
    prio: 'Medium',
    source: 'Portal',
    contact: 'Joost Bakker',
    ci: 'device',
    days: 3.5,
    outcome: 'waiting_customer',
    tech: 'noor',
    ask: 'Per your security policy, admin rights need approval from Pim. Could you forward his approval, or shall we install Docker Desktop via Company Portal instead?',
  },
  {
    co: 'mt',
    title: 'Server 2016 decommission: remove DNS records & AD objects',
    desc: 'Project clean-up: remove stale DNS records, computer objects and GPO links for MT-SRV-01 / MT-SRV-02.',
    type: 'Change Request',
    issue: 'Server',
    sub: 'Active Directory',
    prio: 'Low',
    source: 'Internal',
    queue: 'Projects',
    days: 12,
    outcome: 'closed',
    tech: 'lucas',
    project: 'srv2016',
    steps: ['Removed 2 computer objects, 6 stale DNS records and 1 orphaned GPO link. dcdiag clean.'],
    resolution: 'All references to the retired 2016 servers have been removed from Active Directory and DNS.',
    internal: true,
  },
  {
    co: 'mt',
    title: 'Suspicious sign-in from unfamiliar location',
    desc: 'Identity protection alert: medium-risk sign-in for Lisa Smit from an unfamiliar location.',
    type: 'Incident',
    issue: 'Security',
    sub: 'Account Compromise',
    prio: 'Critical',
    source: 'Monitoring Alert',
    contact: 'Lisa Smit',
    days: 17,
    outcome: 'closed',
    tech: 'lucas',
    steps: [
      'Sign-in from a hotel network abroad with successful MFA. Called Lisa: she is at a conference this week.',
      'As a precaution revoked sessions, reviewed inbox rules (none) and registered the location as known for the trip duration.',
    ],
    resolution: 'The sign-in was yours (conference trip). As a precaution we refreshed your sessions; no further action is needed.',
    tags: ['security'],
    kb: ['phishing'],
  },
  {
    co: 'mt',
    title: 'Laptop keyboard keys not working',
    desc: 'The E and R keys on my laptop stopped working.',
    type: 'Incident',
    issue: 'Hardware',
    sub: 'Laptop',
    prio: 'Low',
    source: 'Email',
    contact: 'Niels Mulder',
    ci: 'MT-LAPTOP-02',
    days: 24,
    outcome: 'closed',
    tech: 'tom',
    steps: ['Lenovo depot repair arranged; loan laptop provided in the meantime.'],
    resolution: 'Your keyboard was replaced under warranty and the laptop is back.',
    onsite: true,
  },
  {
    co: 'mt',
    title: 'Pipeline cannot reach NAS share for artefacts',
    desc: 'Our release pipeline cannot write artefacts to the NAS share since yesterday evening.',
    type: 'Incident',
    issue: 'Server',
    sub: 'Storage',
    prio: 'Medium',
    source: 'Email',
    contact: 'Bas Kuipers',
    ci: 'MT-NAS-01',
    days: 0.7,
    outcome: 'in_progress',
    tech: 'lucas',
    steps: ['SMB signing now required on MT-NAS-01 after DSM update; the Linux build agent mounts with an old cifs option. Testing vers=3.1.1 + seal.'],
  },
  {
    co: 'mt',
    title: 'Offboarding: contractor account removal',
    desc: 'The contract of our external designer ended. Please remove the account.',
    type: 'Service Request',
    issue: 'User Management',
    sub: 'User Offboarding',
    prio: 'Low',
    source: 'Email',
    contact: 'Mila Jansen',
    days: 28,
    outcome: 'closed',
    tech: 'noor',
    steps: ['Guest account removed, shared Figma link revoked, files transferred to Lisa.'],
    resolution: 'The contractor account has been removed and shared files transferred to Lisa Smit.',
    kb: ['offboarding'],
  },
  /* -------------------------------------------------------- Harbor Dental */
  {
    co: 'hd',
    title: 'Practice management software will not start at reception',
    desc: 'The patient agenda software shows a database error at reception. We cannot check in patients!',
    type: 'Incident',
    issue: 'Software',
    sub: 'Application Error',
    prio: 'Critical',
    source: 'Phone',
    contact: 'Lien Desmet',
    ci: 'HD-SRV-01',
    days: 6,
    hour: 8,
    outcome: 'closed',
    tech: 'lucas',
    steps: ['SQL Server (SQLEXPRESS) service stopped on HD-SRV-01 after last night\'s cumulative update; service set to Automatic (Delayed) was reverted to Manual.', 'Started the service, set recovery options to restart on failure, confirmed all 5 workstations can open the agenda.'],
    resolution: 'The database service on the server did not restart after an update. It is running again and will now restart automatically if it ever stops.',
    watchers: ['sarah'],
  },
  {
    key: 'hd-xray',
    co: 'hd',
    title: 'X-ray workstation needs Windows updates outside clinic hours',
    desc: 'The X-ray workstation keeps asking to restart for updates. Please do this when we are closed.',
    type: 'Change Request',
    issue: 'Software',
    sub: 'Updates & Patching',
    prio: 'Low',
    source: 'Email',
    contact: 'Katrien Vermeersch',
    ci: 'HD-DESK-04',
    days: 3,
    outcome: 'scheduled',
    tech: 'tom',
    schedule: 'We scheduled the updates for this week after 18:30, when the practice is closed. The X-ray software vendor confirmed the update is supported.',
  },
  {
    co: 'hd',
    title: 'Reception PC very slow',
    desc: 'The reception computer takes 10 minutes to start.',
    type: 'Incident',
    issue: 'Hardware',
    sub: 'Desktop',
    prio: 'Medium',
    source: 'Phone',
    contact: 'Lien Desmet',
    ci: 'HD-DESK-02',
    days: 36,
    outcome: 'closed',
    tech: 'noor',
    steps: ['HDD at 100 % active time; SMART warnings. Cloned to SSD.'],
    resolution: 'The old hard drive was failing. We replaced it with an SSD; the PC now starts in under a minute.',
    onsite: true,
  },
  {
    co: 'hd',
    title: 'Appointment reminder emails bouncing',
    desc: 'Patients say they do not receive appointment reminders anymore; we see bounce messages.',
    type: 'Incident',
    issue: 'Microsoft 365',
    sub: 'Exchange Online',
    prio: 'High',
    source: 'Email',
    contact: 'Katrien Vermeersch',
    days: 9,
    outcome: 'closed',
    tech: 'lucas',
    slow: true,
    steps: ['Bounces show SPF fail: the reminder service sends from a new IP range that is not in the SPF record.', 'Updated SPF to include the provider and enabled DKIM signing for the domain.'],
    resolution: 'The reminder service had changed its mail servers. We updated your domain\'s e-mail settings (SPF/DKIM); reminders are delivered again.',
  },
  /* --------------------------------------------------------- Alder & Finch */
  {
    co: 'af',
    title: 'Cannot access document management system remotely',
    desc: 'Working from home I can connect to VPN but the document system says "server unavailable".',
    type: 'Incident',
    issue: 'Network',
    sub: 'VPN',
    prio: 'High',
    source: 'Phone',
    contact: 'Sophie van Leeuwen',
    ci: 'device',
    days: 0.8,
    outcome: 'in_progress',
    tech: 'lucas',
    steps: ['VPN connected but DNS resolves the DMS host to the public IP — split DNS missing for this user\'s profile. Pushing updated FortiClient profile.'],
    kb: ['forticlient'],
  },
  {
    co: 'af',
    title: 'Scan to email not working on Canon copier',
    desc: 'The copier gives an error when scanning to email.',
    type: 'Incident',
    issue: 'Hardware',
    sub: 'Printer',
    prio: 'Medium',
    source: 'Email',
    contact: 'Mark de Boer',
    ci: 'AF-PRN-01',
    days: 7,
    outcome: 'resolved',
    tech: 'noor',
    steps: ['Basic SMTP auth was disabled in the tenant. Configured the copier to use the SMTP relay connector (IP-restricted).'],
    resolution: 'Scan to e-mail works again through a secure relay connector.',
    kb: ['printer-drivers'],
  },
  {
    co: 'af',
    title: 'New partner laptop setup',
    desc: 'Daniel needs his new laptop configured with the DMS client and VPN.',
    type: 'Service Request',
    issue: 'Hardware',
    sub: 'Laptop',
    prio: 'Medium',
    source: 'Portal',
    contact: 'Daniel Finch',
    ci: 'AF-LAPTOP-02',
    days: 21,
    outcome: 'closed',
    tech: 'tom',
    steps: ['Autopilot enrolment, DMS client 11.x installed, FortiClient profile pushed, data migrated from old laptop.'],
    resolution: 'Your new laptop is ready with the document system, VPN and your files.',
    onsite: true,
  },
  {
    co: 'af',
    title: 'Encrypted email to client fails to open',
    desc: 'A client says they cannot open the encrypted email I sent them.',
    type: 'Incident',
    issue: 'Microsoft 365',
    sub: 'Exchange Online',
    prio: 'Medium',
    source: 'Email',
    contact: 'Helen Alder',
    days: 0.15,
    outcome: 'new',
    tech: null,
  },
  /* -------------------------------------------------------------- internal */
  {
    co: 'lumen',
    title: 'Quarterly review of patch policies',
    desc: 'Internal: review deferral rings and reboot windows for all managed customers.',
    type: 'Service Request',
    issue: 'Software',
    sub: 'Updates & Patching',
    prio: 'Low',
    source: 'Internal',
    days: 16,
    outcome: 'closed',
    tech: 'tom',
    steps: ['Reviewed rings for 5 customers; Harbor Dental moved to after-hours window (clinic).'],
    resolution: 'Patch policies reviewed and documented.',
    internal: true,
  },
];

interface GenericSpec {
  title: (first: string, last: string) => string;
  desc: string;
  type: string;
  issue: string;
  sub: string;
  prio: Prio;
  source: string;
  ci?: 'device' | 'server' | 'printer';
  alert?: boolean;
  steps: string[];
  resolution: string;
  kb?: string[];
  tags?: string[];
}

const GENERIC: GenericSpec[] = [
  {
    title: (f, l) => `Password reset for ${f} ${l}`,
    desc: 'User is locked out after several failed sign-in attempts.',
    type: 'Service Request',
    issue: 'User Management',
    sub: 'Password Reset',
    prio: 'Low',
    source: 'Phone',
    steps: ['Identity verified via call-back to the number on file. Account unlocked and temporary password issued.'],
    resolution: 'Your account is unlocked and a new password has been set.',
  },
  {
    title: () => 'MFA re-registration after phone replacement',
    desc: 'New phone, Authenticator approvals no longer arrive.',
    type: 'Service Request',
    issue: 'User Management',
    sub: 'Password Reset',
    prio: 'Medium',
    source: 'Phone',
    steps: ['Identity verified. Issued a Temporary Access Pass and guided the user through Authenticator setup.'],
    resolution: 'MFA is registered on your new phone and the old device was removed.',
    kb: ['mfa'],
  },
  {
    title: () => 'Add user to distribution list',
    desc: 'Please add me to the team distribution list so I receive the weekly updates.',
    type: 'Service Request',
    issue: 'Microsoft 365',
    sub: 'Exchange Online',
    prio: 'Low',
    source: 'Portal',
    steps: ['Manager approval present in request. Added member in Exchange admin center.'],
    resolution: 'You have been added to the distribution list.',
  },
  {
    title: () => 'Teams: cannot share screen',
    desc: 'When I try to share my screen in Teams the other participants see a black screen.',
    type: 'Incident',
    issue: 'Microsoft 365',
    sub: 'Teams',
    prio: 'Medium',
    source: 'Chat',
    ci: 'device',
    steps: ['Black screen caused by hardware acceleration with the docking station GPU driver. Updated display driver and dock firmware.'],
    resolution: 'Screen sharing works again after a display driver and docking station update.',
  },
  {
    title: () => 'Printer paper jam error persists',
    desc: 'The printer keeps reporting a paper jam although there is no paper stuck.',
    type: 'Incident',
    issue: 'Hardware',
    sub: 'Printer',
    prio: 'Low',
    source: 'Phone',
    ci: 'printer',
    steps: ['Small torn piece of paper found at the fuser entrance during a remote-guided check. Removed.'],
    resolution: 'A small piece of paper was stuck near the fuser; it was removed and the printer works normally.',
  },
  {
    title: () => 'Software install request: 7-Zip',
    desc: 'I need a tool to open .7z archives from a client.',
    type: 'Service Request',
    issue: 'Software',
    sub: 'Installation',
    prio: 'Low',
    source: 'Portal',
    ci: 'device',
    steps: ['Approved application. Deployed via Company Portal / Action1 software repository.'],
    resolution: '7-Zip is installed on your device.',
  },
  {
    title: () => 'High CPU usage alert',
    desc: 'Monitoring alert: CPU above 90 % for more than 15 minutes.',
    type: 'Alert',
    issue: 'Server',
    sub: 'Performance',
    prio: 'Medium',
    source: 'Monitoring Alert',
    ci: 'server',
    alert: true,
    steps: ['Antivirus full scan overlapping with backup snapshot. Rescheduled the scan to Saturday night.'],
    resolution: 'Cause identified (overlapping scheduled scan and backup); schedule adjusted, CPU normal.',
    tags: ['monitoring'],
  },
  {
    title: () => 'Pending reboot for more than 7 days',
    desc: 'Patch compliance alert: device has had a pending reboot for more than 7 days.',
    type: 'Alert',
    issue: 'Software',
    sub: 'Updates & Patching',
    prio: 'Low',
    source: 'Monitoring Alert',
    ci: 'device',
    alert: true,
    steps: ['Contacted the user; reboot scheduled for 12:30. Update installation confirmed afterwards in Action1.'],
    resolution: 'Device rebooted and fully patched.',
    tags: ['monitoring', 'patching'],
  },
  {
    title: () => 'Defender detected potentially unwanted application',
    desc: 'Endpoint protection alert: PUA detected and quarantined (browser toolbar bundle).',
    type: 'Incident',
    issue: 'Security',
    sub: 'Endpoint Protection',
    prio: 'Medium',
    source: 'Monitoring Alert',
    ci: 'device',
    alert: true,
    steps: ['Quarantine confirmed; full scan clean. User downloaded a free PDF converter — uninstalled and explained the risk.'],
    resolution: 'The unwanted application was removed and a full scan found nothing else.',
    tags: ['security'],
  },
  {
    title: () => 'SharePoint site permission request',
    desc: 'I need edit access to the projects SharePoint site.',
    type: 'Service Request',
    issue: 'Microsoft 365',
    sub: 'SharePoint / OneDrive',
    prio: 'Low',
    source: 'Portal',
    steps: ['Site owner approval received; added to the site Members group.'],
    resolution: 'You now have edit access to the SharePoint site.',
  },
  {
    title: () => 'Licence request for new starter',
    desc: 'Please assign a Microsoft 365 licence for our new colleague starting next week.',
    type: 'Service Request',
    issue: 'Microsoft 365',
    sub: 'Licensing',
    prio: 'Low',
    source: 'Email',
    steps: ['Licence available in the pool; assigned via licence group.'],
    resolution: 'The licence has been assigned.',
    kb: ['onboarding'],
  },
  {
    title: () => 'Mailbox almost full',
    desc: 'Outlook warns that my mailbox is almost full.',
    type: 'Incident',
    issue: 'Microsoft 365',
    sub: 'Outlook',
    prio: 'Low',
    source: 'Email',
    ci: 'device',
    steps: ['Mailbox at 48.6 of 50 GB. Enabled the online archive and applied the 2-year archive policy.'],
    resolution: 'Your online archive is enabled; older mail moves there automatically and your mailbox has room again.',
    kb: ['outlook-profile'],
  },
];

const ACKS = [
  'Hi {first}, thanks for letting us know. I have picked up your ticket and will connect remotely shortly.',
  'Hello {first}, I am looking into this now and will keep you posted on this ticket.',
  'Hi {first}, thanks for the details — I am investigating and will update you within the hour.',
  'Hi {first}, received. I am checking this right away.',
];

const CUSTOMER_REPLIES = [
  'Customer replied by e-mail: available for a remote session after 14:00.',
  'Customer called back and confirmed the issue still occurs.',
  'Customer sent the requested screenshot; continuing troubleshooting.',
];

/* ================================================================== seed */

export async function seedDemo(db: Db, opts: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});

  const [present] = await db.select({ id: s.companies.id }).from(s.companies).where(eq(s.companies.name, DEMO_MARKER_COMPANY)).limit(1);
  if (present) throw new Error('Demo data already present');

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    // Re-check inside the transaction so concurrent runs cannot both insert.
    const [again] = await tx.select({ id: s.companies.id }).from(s.companies).where(eq(s.companies.name, DEMO_MARKER_COMPANY)).limit(1);
    if (again) throw new Error('Demo data already present');
    return seedInTx(tx, { now, log, password, passwordHash });
  });
}

async function seedInTx(
  tx: Tx,
  o: { now: Date; log: (msg: string) => void; password: string; passwordHash: string },
): Promise<SeedDemoResult> {
  const { now, log } = o;
  const rng = new Rng(20261020);
  const cutoff = new Date(now.getTime() - 2 * MIN);

  /** Local Brussels wall-clock time `dayOffset` days from now. */
  const atLocal = (dayOffset: number, hour: number, minute = 0): Date => {
    const base = new Date(now.getTime() + dayOffset * DAY);
    const off = (brussels(base).hour - base.getUTCHours() + 24) % 24;
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour - off, minute));
  };
  /** Next business day (Mon–Fri) `n` business days from today, at a local hour. */
  const businessDay = (n: number, hour: number, minute = 0): Date => {
    let d = 0;
    let left = n;
    let candidate = atLocal(0, hour, minute);
    while (left > 0 || ['Sat', 'Sun'].includes(brussels(candidate).wd)) {
      d++;
      candidate = atLocal(d, hour, minute);
      if (!['Sat', 'Sun'].includes(brussels(candidate).wd)) left--;
    }
    return candidate;
  };

  /* ------------------------------------------------------ reference data */
  const need = <T>(m: Map<string, T>, name: string, what: string): T => {
    const v = m.get(name);
    if (v === undefined) throw new Error(`Base data missing: ${what} "${name}" — run seedBase first`);
    return v;
  };
  const toMap = <R extends { id: number }>(rows: R[], key: (r: R) => string) => new Map(rows.map((r) => [key(r), r.id]));
  const roleIds = toMap(await tx.select().from(s.roles), (r) => r.key);
  const statusIds = toMap(await tx.select().from(s.ticketStatuses), (r) => r.name);
  const prioIds = toMap(await tx.select().from(s.ticketPriorities), (r) => r.name);
  const typeIds = toMap(await tx.select().from(s.ticketTypes), (r) => r.name);
  const sourceIds = toMap(await tx.select().from(s.ticketSources), (r) => r.name);
  const queueIds = toMap(await tx.select().from(s.queues), (r) => r.name);
  const issueRows = await tx.select().from(s.issueTypes);
  const issueIds = toMap(issueRows, (r) => r.name);
  const subRows = await tx.select().from(s.subIssueTypes);
  const subIds = new Map(subRows.map((r) => [`${issueRows.find((i) => i.id === r.issueTypeId)?.name}/${r.name}`, r.id]));
  const workTypeIds = toMap(await tx.select().from(s.workTypes), (r) => r.name);
  const ciTypeIds = toMap(await tx.select().from(s.ciTypes), (r) => r.name);
  const slaIds = toMap(await tx.select().from(s.slaPolicies), (r) => r.name);
  const kbCatIds = toMap(await tx.select().from(s.kbCategories), (r) => r.name);
  const billingIds = toMap(await tx.select().from(s.billingCodes), (r) => r.code);
  const st = (n: string) => need(statusIds, n, 'ticket status');
  const queue = (n: string) => need(queueIds, n, 'queue');
  const workType = (n: string) => need(workTypeIds, n, 'work type');
  const settings = await getSystemSettings(tx);

  /* --------------------------------------------------------------- users */
  const [adminExists] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(s.users)
    .innerJoin(s.roles, eq(s.roles.id, s.users.roleId))
    .where(eq(s.roles.key, 'administrator'));
  const userSpecs: (typeof USERS)[number][] = (adminExists?.n ?? 0) > 0 ? USERS : [DEMO_ADMIN, ...USERS];
  const emails = userSpecs.map((u) => `${slug(u.first)}.${slug(u.last)}@taskora.demo`);
  const clash = await tx.select({ email: s.users.email }).from(s.users).where(inArray(sql`lower(${s.users.email})`, emails));
  if (clash.length) throw new Error('Demo data already present');
  const userRows = await tx
    .insert(s.users)
    .values(
      userSpecs.map((u, i) => ({
        email: emails[i]!,
        firstName: u.first,
        lastName: u.last,
        title: u.title,
        phone: u.phone,
        passwordHash: o.passwordHash,
        roleId: need(roleIds, u.role, 'role'),
        isTechnician: u.tech,
        timezone: 'Europe/Brussels',
        hourlyCost: u.cost,
        createdAt: addDays(now, -400),
      })),
    )
    .returning();
  const U = {} as Record<UserKey, number>;
  userSpecs.forEach((u, i) => (U[u.key] = userRows[i]!.id));
  const actorId = U.admin ?? U.sarah;
  log(`Created ${userRows.length} users`);

  if (!(await tx.select().from(s.systemSettings).where(eq(s.systemSettings.key, 'system'))).length) {
    await saveSystemSettings(tx, {
      organizationName: 'Lumen IT Services',
      timezone: 'Europe/Brussels',
      companyAddress: 'Lumen IT Services (demo)\nRue des Tisserands 9\n1000 Brussels, Belgium',
    });
  }

  /* ----------------------------------------------- companies & locations */
  const C = {} as Record<CoKey, number>;
  const L = {} as Record<CoKey, number[]>;
  for (const c of COMPANIES) {
    const [row] = await tx
      .insert(s.companies)
      .values({
        name: c.name,
        accountNumber: c.accountNumber,
        type: c.type,
        industry: c.industry,
        website: `https://www.${c.domain}`,
        phone: c.phone,
        email: `info@${c.domain}`,
        address1: c.address1,
        city: c.city,
        postalCode: c.postalCode,
        country: c.country,
        accountManagerId: U[c.manager],
        defaultSlaId: c.sla ? need(slaIds, c.sla, 'SLA policy') : null,
        notes: c.notes,
        createdById: actorId,
        createdAt: addDays(now, -380),
      })
      .returning();
    C[c.key] = row!.id;
    const locs = await tx
      .insert(s.locations)
      .values(c.locations.map((l) => ({ companyId: row!.id, name: l.name, address1: l.address1, city: l.city, postalCode: l.postalCode, country: c.country, phone: l.phone ?? null, isPrimary: !!l.primary })))
      .returning();
    L[c.key] = locs.map((l) => l.id);
  }
  log(`Created ${COMPANIES.length} companies`);

  /* ------------------------------------------------------------ contacts */
  type ContactInfo = { id: number; first: string; last: string; co: CoKey; active: boolean };
  const contactByName = new Map<string, ContactInfo>(); // key `${co}:${first} ${last}`
  const contactsOf = {} as Record<CoKey, ContactInfo[]>;
  let contactCount = 0;
  for (const c of COMPANIES) {
    const spec = CONTACTS[c.key];
    contactsOf[c.key] = [];
    if (!spec.rows.length) continue;
    const phoneBase = c.phone.slice(0, -2);
    const rows = await tx
      .insert(s.contacts)
      .values(
        spec.rows.map(([first, last, title, department, active, loc], i) => ({
          companyId: C[c.key],
          locationId: L[c.key]![loc ?? 0] ?? L[c.key]![0]!,
          firstName: first,
          lastName: last,
          title,
          department,
          email: `${slug(first)}.${slug(last)}@${c.domain}`,
          phone: `${phoneBase}${String(10 + i).padStart(2, '0')}`,
          mobile: c.country === 'Belgium' ? `+32 470 55 5${String(100 + i + contactCount).slice(-3)}` : `+31 6 5555 0${String(100 + i + contactCount).slice(-3)}`,
          isActive: active !== false,
          isPrimary: `${first} ${last}` === spec.primary,
          notes: active === false ? 'Left the company — account disabled.' : null,
          createdAt: addDays(now, -360 + i),
        })),
      )
      .returning();
    contactCount += rows.length;
    for (const r of rows) {
      const info = { id: r.id, first: r.firstName, last: r.lastName, co: c.key, active: r.isActive };
      contactByName.set(`${c.key}:${r.firstName} ${r.lastName}`, info);
      contactsOf[c.key].push(info);
    }
    const primary = rows.find((r) => r.isPrimary);
    if (primary) await tx.update(s.companies).set({ primaryContactId: primary.id }).where(eq(s.companies.id, C[c.key]));
  }
  const contact = (co: CoKey, name: string) => need(contactByName, `${co}:${name}`, 'contact');
  log(`Created ${contactCount} contacts`);

  /* --------------------------------------------------------------- CMDB */
  interface CiSpec {
    name: string;
    type: string;
    contact?: string;
    loc?: number;
    manufacturer?: string;
    model?: string;
    os?: string;
    osVersion?: string;
    cpu?: string;
    ram?: number;
    storage?: number;
    ip?: string;
    lifecycle?: string;
    ageDays?: number;
    warrantyInDays?: number;
    supportInDays?: number;
    cost?: number;
    notes?: string;
    noSerial?: boolean;
  }
  const serialFor = (m?: string): string | null => {
    switch (m) {
      case 'Dell':
        return rng.chars(7);
      case 'HP':
      case 'HPE':
        return `5CG${rng.chars(7)}`;
      case 'Lenovo':
        return `PF${rng.chars(6)}`;
      case 'Apple':
        return rng.chars(10, 'CDFGHJKLMNPQRTVWXY0123456789');
      case 'Fortinet':
        return `FGT${rng.chars(2, '0123456789')}FTK${rng.chars(8, '0123456789')}`;
      case 'Synology':
        return `${rng.chars(4, '0123456789')}${rng.chars(3, 'ABCDEFGHJKLMNPQRSTUVWXYZ')}${rng.chars(6, '0123456789')}`;
      case undefined:
        return null;
      default:
        return `DEMO${rng.chars(8)}`;
    }
  };
  const macFor = () => `02:${Array.from({ length: 5 }, () => rng.chars(2, '0123456789ABCDEF')).join(':')}`;

  const win11 = { os: 'Windows 11 Pro', osVersion: '23H2' };
  const fleet: Record<CoKey, CiSpec[]> = { lumen: [], ns: [], bp: [], mt: [], hd: [], af: [], cl: [] };

  // Northstar: one laptop per employee (NS-LAPTOP-0xx follows the contact order; Emma Smith = 014).
  CONTACTS.ns.rows.forEach(([first, last, , , active], i) => {
    const n = String(i + 1).padStart(3, '0');
    const name = `NS-LAPTOP-${n}`;
    const model = i % 9 === 4 ? 'ThinkPad T14 Gen 4' : i % 5 === 2 ? 'Latitude 5440' : 'Latitude 7440';
    const manufacturer = model.startsWith('ThinkPad') ? 'Lenovo' : 'Dell';
    const spec: CiSpec = {
      name,
      type: 'Laptop',
      manufacturer,
      model: `${manufacturer} ${model}`,
      ...win11,
      cpu: 'Intel Core i7-1365U',
      ram: i % 3 === 0 ? 32 : 16,
      storage: 512,
      ip: `10.10.20.${100 + i}`,
      ageDays: rng.int(120, 1500),
      cost: model === 'Latitude 7440' ? 1649 : 1189,
      contact: active === false ? undefined : `${first} ${last}`,
    };
    if (name === 'NS-LAPTOP-014') Object.assign(spec, { model: 'Dell Latitude 7440', manufacturer: 'Dell', ageDays: 610, ram: 16, notes: 'Primary laptop of Emma Smith (Senior Consultant).' });
    if (name === 'NS-LAPTOP-003') spec.warrantyInDays = 21;
    if (name === 'NS-LAPTOP-019') spec.warrantyInDays = 47;
    if (name === 'NS-LAPTOP-011') spec.lifecycle = 'in_repair';
    if (name === 'NS-LAPTOP-018') Object.assign(spec, { lifecycle: 'in_stock', notes: 'Returned by a departed employee; reimaged for the next new starter.' });
    if (name === 'NS-LAPTOP-023') Object.assign(spec, { lifecycle: 'retired', ageDays: 1700, notes: 'Retired — swollen battery.' });
    fleet.ns.push(spec);
  });
  fleet.ns.push(
    { name: 'NS-HV-01', type: 'Server', manufacturer: 'Dell', model: 'Dell PowerEdge R650xs', os: 'Windows Server 2022 Datacenter', osVersion: '21H2', cpu: 'Intel Xeon Silver 4314', ram: 256, storage: 7680, ip: '10.10.1.10', ageDays: 900, cost: 9800, notes: 'Hyper-V host' },
    { name: 'NS-DC01', type: 'Virtual Machine', os: 'Windows Server 2022 Standard', osVersion: '21H2', ram: 8, storage: 120, ip: '10.10.1.11', ageDays: 900, notes: 'AD DS, DNS, DHCP', noSerial: true },
    { name: 'NS-FS01', type: 'Virtual Machine', os: 'Windows Server 2022 Standard', osVersion: '21H2', ram: 16, storage: 2048, ip: '10.10.1.12', ageDays: 900, notes: 'File server — shares being migrated to SharePoint', noSerial: true },
    { name: 'NS-APP01', type: 'Virtual Machine', os: 'Windows Server 2022 Standard', osVersion: '21H2', ram: 16, storage: 200, ip: '10.10.1.13', ageDays: 700, notes: 'Time-tracking application server', noSerial: true },
    { name: 'NS-FW-01', type: 'Firewall', manufacturer: 'Fortinet', model: 'FortiGate 60F', os: 'FortiOS', osVersion: '7.4', ip: '10.10.0.1', ageDays: 1000, supportInDays: 34, cost: 1150 },
    { name: 'NS-SW-01', type: 'Network Switch', manufacturer: 'HPE', model: 'Aruba CX 6100 48G PoE', ip: '10.10.99.2', ageDays: 1000, cost: 1890 },
    { name: 'NS-SW-02', type: 'Network Switch', manufacturer: 'HPE', model: 'Aruba CX 6100 24G PoE', ip: '10.10.99.3', ageDays: 1000, cost: 1290 },
    { name: 'NS-AP-01', type: 'Wireless Access Point', manufacturer: 'Ubiquiti', model: 'UniFi U6 Pro', ip: '10.10.99.21', ageDays: 800 },
    { name: 'NS-AP-02', type: 'Wireless Access Point', manufacturer: 'Ubiquiti', model: 'UniFi U6 Pro', ip: '10.10.99.22', ageDays: 800 },
    { name: 'NS-AP-03', type: 'Wireless Access Point', manufacturer: 'Ubiquiti', model: 'UniFi U6 Pro', ip: '10.10.99.23', ageDays: 800 },
    { name: 'NS-PRN-01', type: 'Printer', manufacturer: 'HP', model: 'HP Color LaserJet Pro MFP 4302fdw', ip: '10.10.20.31', ageDays: 500, notes: '2nd floor' },
    { name: 'NS-PRN-02', type: 'Printer', manufacturer: 'Brother', model: 'Brother MFC-L8900CDW', ip: '10.10.20.32', ageDays: 1300, notes: 'Reception' },
    { name: 'NS-NAS-01', type: 'NAS', manufacturer: 'Synology', model: 'Synology DS923+', os: 'DSM', osVersion: '7.2', storage: 16000, ip: '10.10.1.20', ageDays: 700, cost: 1450 },
    { name: 'Northstar Microsoft 365 tenant', type: 'Cloud Service', manufacturer: 'Microsoft', model: 'Microsoft 365', notes: 'Tenant: northstar-consulting.example (demo)', noSerial: true },
    { name: 'Microsoft 365 Business Premium (25 seats)', type: 'License', manufacturer: 'Microsoft', model: 'M365 Business Premium', supportInDays: 160, notes: 'Annual commitment, renews automatically', noSerial: true },
  );

  // BluePeak: HQ (loc 0) and Mechelen warehouse (loc 1).
  const bpUsers = ['Karel Vos', 'Ingrid Smets', 'Hassan Amrani', 'Eva Lenaerts', 'Anouk De Wit', 'Marco Rossi'];
  bpUsers.forEach((name, i) =>
    fleet.bp.push({ name: `BP-DESK-0${i + 1}`, type: 'Desktop', contact: name, manufacturer: 'HP', model: 'HP EliteDesk 800 G9 Mini', ...win11, cpu: 'Intel Core i5-12500T', ram: 16, storage: 256, ip: `10.20.20.${110 + i}`, ageDays: rng.int(200, 1400), cost: 879 }),
  );
  ['Wout Aerts', 'Leen Bogaerts', 'Stijn Coppens', null].forEach((name, i) =>
    fleet.bp.push({ name: `BP-LAPTOP-0${i + 1}`, type: 'Laptop', contact: name ?? undefined, loc: 1, manufacturer: 'HP', model: 'HP EliteBook 840 G10', ...win11, cpu: 'Intel Core i5-1335U', ram: 16, storage: 512, ip: `10.21.20.${120 + i}`, ageDays: rng.int(100, 900), cost: 1249, notes: name ? undefined : 'Shared dispatch laptop' }),
  );
  fleet.bp.push(
    { name: 'BP-WH-PC01', type: 'Desktop', loc: 1, manufacturer: 'HP', model: 'HP ProDesk 400 G9', ...win11, ram: 8, storage: 256, ip: '10.21.20.50', ageDays: 300, notes: 'Warehouse office PC (shipping)' },
    { name: 'BP-WH-PC01 (old)', type: 'Desktop', loc: 1, manufacturer: 'HP', model: 'HP ProDesk 400 G4', os: 'Windows 10 Pro', osVersion: '22H2', ram: 8, storage: 256, ageDays: 2300, lifecycle: 'retired', notes: 'Replaced; record kept for asset history (same hostname as the new PC).' },
    { name: 'BP-HV-01', type: 'Server', manufacturer: 'HPE', model: 'HPE ProLiant DL360 Gen10 Plus', os: 'Windows Server 2022 Standard', osVersion: '21H2', cpu: 'Intel Xeon Silver 4310', ram: 128, storage: 3840, ip: '10.20.1.10', ageDays: 1080, warrantyInDays: 12, cost: 7400, notes: 'Hyper-V host — warranty ending, replacement quoted' },
    { name: 'BP-DC01', type: 'Virtual Machine', os: 'Windows Server 2022 Standard', osVersion: '21H2', ram: 8, storage: 120, ip: '10.20.1.11', ageDays: 1080, noSerial: true },
    { name: 'BP-WMS01', type: 'Virtual Machine', os: 'Windows Server 2019 Standard', osVersion: '1809', ram: 32, storage: 500, ip: '10.20.1.12', ageDays: 1080, notes: 'Warehouse management system + SQL Server', noSerial: true },
    { name: 'BP-FW-01', type: 'Firewall', manufacturer: 'Fortinet', model: 'FortiGate 80F', os: 'FortiOS', osVersion: '7.4', ip: '10.20.0.1', ageDays: 900 },
    { name: 'BP-FW-02', type: 'Firewall', loc: 1, manufacturer: 'Fortinet', model: 'FortiGate 40F', os: 'FortiOS', osVersion: '7.2', ip: '10.21.0.1', ageDays: 900 },
    { name: 'BP-SW-01', type: 'Network Switch', manufacturer: 'HPE', model: 'Aruba CX 6000 24G', ip: '10.20.99.2', ageDays: 900 },
    { name: 'BP-SW-02', type: 'Network Switch', loc: 1, manufacturer: 'HPE', model: 'Aruba 2930F 24G PoE+', ip: '10.21.99.2', ageDays: 2100 },
  );
  for (let i = 1; i <= 4; i++) {
    fleet.bp.push({ name: `BP-AP-0${i}`, type: 'Wireless Access Point', loc: 1, manufacturer: 'Ubiquiti', model: 'UniFi AC Pro', ip: `10.21.99.${20 + i}`, ageDays: 2200, notes: 'End of life — part of the Wi-Fi refresh' });
  }
  fleet.bp.push(
    { name: 'BP-PRN-01', type: 'Printer', loc: 1, manufacturer: 'Zebra', model: 'Zebra ZT411 label printer', ip: '10.21.20.40', ageDays: 700, notes: 'Loading dock' },
    { name: 'BP-PRN-02', type: 'Printer', manufacturer: 'HP', model: 'HP LaserJet Enterprise M507', ip: '10.20.20.40', ageDays: 1500 },
    { name: 'BluePeak Microsoft 365 tenant', type: 'Cloud Service', manufacturer: 'Microsoft', model: 'Microsoft 365', noSerial: true },
  );

  // Meridian
  ['Pim van den Berg', 'Joost Bakker', 'Fleur Visser', 'Yara Hoekstra', 'Lisa Smit'].forEach((name, i) =>
    fleet.mt.push({ name: `MT-MBP-0${i + 1}`, type: 'Laptop', contact: name, manufacturer: 'Apple', model: 'MacBook Pro 14" (M3 Pro)', os: 'macOS Sonoma', osVersion: '14.6', cpu: 'Apple M3 Pro', ram: 36, storage: 1024, ip: `10.30.20.${100 + i}`, ageDays: rng.int(100, 700), cost: 2899 }),
  );
  ['Ravi Menon', 'Niels Mulder', 'Bas Kuipers', 'Sanne de Vries', 'Mila Jansen'].forEach((name, i) =>
    fleet.mt.push({ name: `MT-LAPTOP-0${i + 1}`, type: 'Laptop', contact: name, manufacturer: 'Lenovo', model: 'ThinkPad X1 Carbon Gen 11', ...win11, cpu: 'Intel Core i7-1355U', ram: 32, storage: 1024, ip: `10.30.20.${110 + i}`, ageDays: rng.int(150, 1300), cost: 1999 }),
  );
  fleet.mt.push(
    { name: 'MT-SRV-01', type: 'Server', manufacturer: 'Dell', model: 'Dell PowerEdge R740', os: 'Windows Server 2016 Standard', osVersion: '1607', ram: 128, storage: 4000, ageDays: 2600, lifecycle: 'retired', notes: 'Retired in the Server 2016 retirement project; disks wiped.' },
    { name: 'MT-SRV-02', type: 'Server', manufacturer: 'Dell', model: 'Dell PowerEdge R640', os: 'Windows Server 2016 Standard', osVersion: '1607', ram: 64, storage: 2000, ageDays: 2500, lifecycle: 'retired', notes: 'Retired in the Server 2016 retirement project; disks wiped.' },
    { name: 'MT-HV-01', type: 'Server', manufacturer: 'Dell', model: 'Dell PowerEdge R760', os: 'Windows Server 2022 Datacenter', osVersion: '21H2', cpu: 'Intel Xeon Gold 5415+', ram: 256, storage: 7680, ip: '10.30.1.10', ageDays: 75, cost: 12400 },
    { name: 'MT-DC01', type: 'Virtual Machine', os: 'Windows Server 2022 Standard', osVersion: '21H2', ram: 8, storage: 120, ip: '10.30.1.11', ageDays: 70, noSerial: true },
    { name: 'MT-BUILD01', type: 'Virtual Machine', os: 'Ubuntu Server', osVersion: '22.04 LTS', ram: 32, storage: 400, ip: '10.30.1.20', ageDays: 60, notes: 'Self-hosted CI build agent', noSerial: true },
    { name: 'MT-FW-01', type: 'Firewall', manufacturer: 'Fortinet', model: 'FortiGate 100F', os: 'FortiOS', osVersion: '7.4', ip: '10.30.0.1', ageDays: 800 },
    { name: 'MT-SW-01', type: 'Network Switch', manufacturer: 'HPE', model: 'Aruba CX 6200F 48G', ip: '10.30.99.2', ageDays: 800 },
    { name: 'MT-NAS-01', type: 'NAS', manufacturer: 'Synology', model: 'Synology RS1221+', os: 'DSM', osVersion: '7.2', storage: 32000, ip: '10.30.1.30', ageDays: 1100 },
    { name: 'Meridian Azure subscription', type: 'Cloud Service', manufacturer: 'Microsoft', model: 'Azure', notes: 'Pay-as-you-go subscription (demo)', noSerial: true },
  );

  // Harbor Dental
  [['HD-DESK-01', 'Lien Desmet', 'Reception'], ['HD-DESK-02', 'Lien Desmet', 'Reception 2'], ['HD-DESK-03', 'Jens Lievens', 'Treatment room 1'], ['HD-DESK-04', null, 'X-ray workstation'], ['HD-DESK-05', 'Katrien Vermeersch', 'Office']].forEach(([name, who, note], i) =>
    fleet.hd.push({ name: name!, type: 'Desktop', contact: who ?? undefined, manufacturer: 'Dell', model: 'Dell OptiPlex 7010 Micro', ...win11, ram: 16, storage: 512, ip: `10.40.20.${101 + i}`, ageDays: rng.int(300, 1600), notes: note! }),
  );
  fleet.hd.push(
    { name: 'HD-SRV-01', type: 'Server', manufacturer: 'Dell', model: 'Dell PowerEdge T350', os: 'Windows Server 2019 Standard', osVersion: '1809', ram: 32, storage: 2000, ip: '10.40.1.10', ageDays: 1300, notes: 'Practice management software + SQL Express' },
    { name: 'HD-FW-01', type: 'Firewall', manufacturer: 'Fortinet', model: 'FortiGate 40F', os: 'FortiOS', osVersion: '7.2', ip: '10.40.0.1', ageDays: 1300 },
    { name: 'HD-PRN-01', type: 'Printer', manufacturer: 'HP', model: 'HP LaserJet Pro MFP 3102fdw', ip: '10.40.20.30', ageDays: 400 },
    { name: 'HD-NAS-01', type: 'NAS', manufacturer: 'Synology', model: 'Synology DS224+', os: 'DSM', osVersion: '7.2', storage: 8000, ip: '10.40.1.20', ageDays: 600 },
  );

  // Alder & Finch
  ['Helen Alder', 'Daniel Finch', 'Sophie van Leeuwen', 'Ruud Hendriks', 'Anna Kramer', 'Mark de Boer', 'Eline Vos'].forEach((name, i) =>
    fleet.af.push({ name: `AF-LAPTOP-0${i + 1}`, type: 'Laptop', contact: name, manufacturer: 'HP', model: 'HP EliteBook 840 G9', ...win11, cpu: 'Intel Core i7-1255U', ram: 16, storage: 512, ip: `10.50.20.${100 + i}`, ageDays: i === 1 ? 22 : rng.int(200, 1400) }),
  );
  fleet.af.push(
    { name: 'AF-FW-01', type: 'Firewall', manufacturer: 'Fortinet', model: 'FortiGate 40F', os: 'FortiOS', osVersion: '7.4', ip: '10.50.0.1', ageDays: 700 },
    { name: 'AF-NAS-01', type: 'NAS', manufacturer: 'Synology', model: 'Synology DS1522+', os: 'DSM', osVersion: '7.2', storage: 20000, ip: '10.50.1.20', ageDays: 1040, warrantyInDays: 55, notes: 'Document management system storage + backups' },
    { name: 'AF-PRN-01', type: 'Printer', manufacturer: 'Canon', model: 'Canon imageRUNNER ADVANCE DX C3826i', ip: '10.50.20.30', ageDays: 900 },
    { name: 'Alder & Finch Microsoft 365 tenant', type: 'Cloud Service', manufacturer: 'Microsoft', model: 'Microsoft 365', noSerial: true },
  );

  // Internal
  fleet.lumen.push(
    { name: 'LUM-FW-01', type: 'Firewall', manufacturer: 'Fortinet', model: 'FortiGate 60F', os: 'FortiOS', osVersion: '7.4', ip: '10.0.0.1', ageDays: 600 },
    { name: 'LUM-NAS-01', type: 'NAS', manufacturer: 'Synology', model: 'Synology DS923+', os: 'DSM', osVersion: '7.2', ip: '10.0.1.20', ageDays: 600, notes: 'Internal documentation and tooling backups' },
  );

  type CiRow = typeof s.configurationItems.$inferSelect;
  const CI = new Map<string, CiRow>();
  const deviceOfContact = new Map<number, number>();
  for (const co of Object.keys(fleet) as CoKey[]) {
    const specs = fleet[co];
    if (!specs.length) continue;
    const values: (typeof s.configurationItems.$inferInsert)[] = [];
    for (const spec of specs) {
      const ciNumber = formatNumber(settings.ciPrefix, await nextSequence(tx, 'ci'));
      const physical = !spec.noSerial && spec.type !== 'Cloud Service' && spec.type !== 'License';
      let purchase = spec.ageDays !== undefined ? addDays(now, -spec.ageDays) : null;
      let warranty = purchase ? addDays(purchase, 3 * 365) : null;
      if (spec.warrantyInDays !== undefined) {
        warranty = addDays(now, spec.warrantyInDays);
        purchase = addDays(warranty, -3 * 365);
      }
      const contactId = spec.contact ? contact(co, spec.contact).id : null;
      values.push({
        ciNumber,
        name: spec.name,
        ciTypeId: need(ciTypeIds, spec.type, 'CI type'),
        companyId: C[co],
        contactId,
        locationId: L[co]![spec.loc ?? 0] ?? L[co]![0]!,
        manufacturer: spec.manufacturer ? (spec.manufacturer === 'Dell' ? 'Dell Inc.' : spec.manufacturer) : null,
        model: spec.model ?? null,
        serialNumber: physical ? serialFor(spec.manufacturer) : null,
        assetTag: physical ? `${spec.name.split('-')[0]}-A${ciNumber.slice(-4)}` : null,
        hostname: physical || spec.type === 'Virtual Machine' ? spec.name.replace(' (old)', '') : null,
        osName: spec.os ?? null,
        osVersion: spec.osVersion ?? null,
        ipAddress: spec.ip ?? null,
        macAddress: physical && spec.ip ? macFor() : null,
        cpu: spec.cpu ?? null,
        ramGb: spec.ram ?? null,
        storageGb: spec.storage ?? null,
        purchaseDate: physical && purchase ? isoDate(purchase) : null,
        purchaseCost: spec.cost ?? null,
        warrantyExpiresAt: physical && warranty ? isoDate(warranty) : null,
        supportExpiresAt: spec.supportInDays !== undefined ? isoDate(addDays(now, spec.supportInDays)) : null,
        installDate: purchase ? isoDate(addDays(purchase, 7)) : null,
        lifecycleStatus: spec.lifecycle ?? 'active',
        notes: spec.notes ?? null,
        createdById: actorId,
        createdAt: purchase ? addDays(purchase, 7) : addDays(now, -365),
      });
    }
    const rows = await tx.insert(s.configurationItems).values(values).returning();
    for (const r of rows) {
      CI.set(r.name, r);
      if (r.contactId && !deviceOfContact.has(r.contactId)) deviceOfContact.set(r.contactId, r.id);
    }
  }
  const ci = (name: string) => need(CI, name, 'configuration item');

  const relations: [string, string, string][] = [
    ['NS-HV-01', 'NS-DC01', 'hosts'],
    ['NS-HV-01', 'NS-FS01', 'hosts'],
    ['NS-HV-01', 'NS-APP01', 'hosts'],
    ['NS-SW-01', 'NS-FW-01', 'connected_to'],
    ['NS-SW-02', 'NS-SW-01', 'connected_to'],
    ['NS-AP-01', 'NS-SW-01', 'connected_to'],
    ['NS-AP-02', 'NS-SW-01', 'connected_to'],
    ['NS-AP-03', 'NS-SW-02', 'connected_to'],
    ['NS-NAS-01', 'NS-HV-01', 'backs_up'],
    ['Microsoft 365 Business Premium (25 seats)', 'Northstar Microsoft 365 tenant', 'licensed_for'],
    ['BP-HV-01', 'BP-DC01', 'hosts'],
    ['BP-HV-01', 'BP-WMS01', 'hosts'],
    ['BP-SW-01', 'BP-FW-01', 'connected_to'],
    ['BP-SW-02', 'BP-FW-02', 'connected_to'],
    ['BP-AP-01', 'BP-SW-02', 'connected_to'],
    ['BP-AP-02', 'BP-SW-02', 'connected_to'],
    ['BP-AP-03', 'BP-SW-02', 'connected_to'],
    ['BP-AP-04', 'BP-SW-02', 'connected_to'],
    ['MT-HV-01', 'MT-DC01', 'hosts'],
    ['MT-HV-01', 'MT-BUILD01', 'hosts'],
    ['MT-SW-01', 'MT-FW-01', 'connected_to'],
    ['MT-BUILD01', 'MT-NAS-01', 'depends_on'],
    ['HD-NAS-01', 'HD-SRV-01', 'backs_up'],
    ['HD-DESK-01', 'HD-SRV-01', 'depends_on'],
    ['AF-NAS-01', 'AF-FW-01', 'connected_to'],
  ];
  await tx.insert(s.ciRelations).values(relations.map(([a, b, type]) => ({ ciId: ci(a).id, relatedCiId: ci(b).id, type, createdAt: addDays(now, -200) })));

  const softwareRows: (typeof s.ciSoftware.$inferInsert)[] = [];
  const winApps: [string, string, string][] = [
    ['Microsoft 365 Apps for business', '16.0.17928.20156', 'Microsoft Corporation'],
    ['Microsoft Teams', '24215.1007.3082.1590', 'Microsoft Corporation'],
    ['FortiClient VPN', '7.2.4.0972', 'Fortinet Technologies Inc.'],
    ['Google Chrome', '129.0.6668.90', 'Google LLC'],
    ['Adobe Acrobat Reader', '24.003.20112', 'Adobe Inc.'],
    ['7-Zip', '24.08', 'Igor Pavlov'],
  ];
  for (const r of CI.values()) {
    if (r.lifecycleStatus !== 'active' || !r.osName?.startsWith('Windows 11')) continue;
    const n = rng.int(3, winApps.length);
    for (const [name, version, publisher] of winApps.slice(0, n)) {
      softwareRows.push({ ciId: r.id, name, version, publisher, installedAt: r.installDate, source: 'manual', createdAt: r.createdAt });
    }
  }
  softwareRows.push(
    { ciId: ci('HD-SRV-01').id, name: 'Microsoft SQL Server 2019 Express', version: '15.0.4385.2', publisher: 'Microsoft Corporation', source: 'manual' },
    { ciId: ci('HD-SRV-01').id, name: 'DentaPlan Practice Server (demo)', version: '8.4.2', publisher: 'Example Dental Software', licenseKeyRef: 'Password vault: HD / DentaPlan licence', source: 'manual' },
    { ciId: ci('BP-WMS01').id, name: 'Microsoft SQL Server 2019 Standard', version: '15.0.4385.2', publisher: 'Microsoft Corporation', source: 'manual' },
    { ciId: ci('BP-WMS01').id, name: 'WarehouseFlow WMS Server (demo)', version: '12.1', publisher: 'Example Logistics Software', source: 'manual' },
    { ciId: ci('NS-APP01').id, name: 'TimeTrack Server (demo)', version: '5.2.0', publisher: 'Example Software Ltd', source: 'manual' },
    { ciId: ci('MT-BUILD01').id, name: 'Docker Engine', version: '27.3.1', publisher: 'Docker Inc.', source: 'manual' },
  );
  await tx.insert(s.ciSoftware).values(softwareRows);
  log(`Created ${CI.size} configuration items, ${relations.length} relations, ${softwareRows.length} software rows`);

  /* ----------------------------------------------- services & contracts */
  await tx.insert(s.services).values(SERVICES).onConflictDoNothing({ target: s.services.name });
  const serviceRows = await tx.select().from(s.services).where(inArray(s.services.name, SERVICES.map((x) => x.name)));
  const svc = (name: string) => serviceRows.find((r) => r.name === name)!;
  const year = now.getUTCFullYear();
  const firstOfMonth = (monthsAgo: number) => isoDate(new Date(Date.UTC(year, now.getUTCMonth() - monthsAgo, 1)));
  const contractNumber = async () => formatNumber(settings.contractPrefix, await nextSequence(tx, 'contract'));
  type ContractRow = typeof s.contracts.$inferSelect;
  const K = {} as Record<'nsMsa' | 'nsMigration' | 'bpBlock' | 'mtTm' | 'mtSrv' | 'hdMsa' | 'afRetainer', ContractRow>;
  const addContract = async (key: keyof typeof K, v: Omit<typeof s.contracts.$inferInsert, 'contractNumber'>) => {
    const [row] = await tx.insert(s.contracts).values({ ...v, contractNumber: await contractNumber() }).returning();
    K[key] = row!;
    return row!;
  };
  const nsServices = [
    { service: 'Managed Workstation', qty: 25 },
    { service: 'Managed Server', qty: 3 },
    { service: 'Microsoft 365 Management', qty: 25 },
    { service: 'Backup & Disaster Recovery', qty: 1 },
    { service: 'Managed Firewall', qty: 1 },
  ];
  const sumServices = (list: { service: string; qty: number }[]) => list.reduce((acc, x) => acc + x.qty * svc(x.service).unitPrice, 0);
  await addContract('nsMsa', {
    name: 'Managed Services Agreement',
    companyId: C.ns,
    type: 'recurring',
    status: 'active',
    startDate: firstOfMonth(18),
    endDate: isoDate(addDays(new Date(`${firstOfMonth(18)}T00:00:00Z`), 3 * 365 - 1)),
    slaId: need(slaIds, 'Premium SLA', 'SLA policy'),
    contactId: contact('ns', 'Pieter Claes').id,
    isDefault: true,
    recurringAmount: sumServices(nsServices),
    billingPeriod: 'monthly',
    overageRate: 95,
    description: 'Fully managed workstations, servers, firewall and Microsoft 365 with Premium SLA. Remote and onsite support included.',
    createdAt: addDays(now, -540),
  });
  await tx.insert(s.contractServices).values(nsServices.map((x) => ({ contractId: K.nsMsa.id, serviceId: svc(x.service).id, quantity: x.qty, unitPrice: svc(x.service).unitPrice, startDate: K.nsMsa.startDate })));
  await addContract('nsMigration', {
    name: 'Microsoft 365 Migration — Fixed Price',
    companyId: C.ns,
    type: 'fixed_price',
    status: 'active',
    startDate: isoDate(addDays(now, -30)),
    endDate: isoDate(addDays(now, 45)),
    contactId: contact('ns', 'Charlotte Dubois').id,
    fixedAmount: 6900,
    billingPeriod: 'one_time',
    description: 'Fixed-price tenant migration project (see project).',
    createdAt: addDays(now, -32),
  });
  await addContract('bpBlock', {
    name: `Block Hours ${year}`,
    companyId: C.bp,
    type: 'block_hours',
    status: 'active',
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
    slaId: need(slaIds, 'Standard SLA', 'SLA policy'),
    contactId: contact('bp', 'Karel Vos').id,
    isDefault: true,
    hourlyRate: 95,
    overageRate: 110,
    billingPeriod: 'one_time',
    description: 'Prepaid support hours. Additional blocks are purchased when the balance drops below 5 hours.',
    createdAt: new Date(Date.UTC(year - 1, 11, 15)),
  });
  await tx.insert(s.contractBlocks).values([
    { contractId: K.bpBlock.id, hours: 40, amount: 3600, startDate: `${year}-01-01`, endDate: `${year}-12-31`, isPaid: true, createdAt: new Date(Date.UTC(year - 1, 11, 15)) },
    { contractId: K.bpBlock.id, hours: 40, amount: 3600, startDate: firstOfMonth(2), endDate: `${year}-12-31`, isPaid: false, createdAt: new Date(`${firstOfMonth(2)}T09:00:00Z`) },
  ]);
  await addContract('mtTm', {
    name: 'Time & Materials',
    companyId: C.mt,
    type: 'time_materials',
    status: 'active',
    startDate: firstOfMonth(30),
    slaId: need(slaIds, 'Standard SLA', 'SLA policy'),
    contactId: contact('mt', 'Pim van den Berg').id,
    isDefault: true,
    billingPeriod: 'monthly',
    description: 'All support billed monthly at the agreed rates per work type.',
    createdAt: addDays(now, -900),
  });
  await tx.insert(s.contractRates).values([
    { contractId: K.mtTm.id, workTypeId: workType('Remote Support'), hourlyRate: 105 },
    { contractId: K.mtTm.id, workTypeId: workType('Onsite Support'), hourlyRate: 125 },
    { contractId: K.mtTm.id, workTypeId: workType('Project Work'), hourlyRate: 115 },
    { contractId: K.mtTm.id, workTypeId: workType('After-hours Emergency'), hourlyRate: 175 },
  ]);
  await addContract('mtSrv', {
    name: 'Server 2016 Retirement — Fixed Price',
    companyId: C.mt,
    type: 'fixed_price',
    status: 'expired',
    startDate: isoDate(addDays(now, -85)),
    endDate: isoDate(addDays(now, -9)),
    contactId: contact('mt', 'Pim van den Berg').id,
    fixedAmount: 8500,
    billingPeriod: 'one_time',
    description: 'Replacement of two Windows Server 2016 hosts (project completed).',
    createdAt: addDays(now, -86),
  });
  const hdServices = [
    { service: 'Managed Workstation', qty: 5 },
    { service: 'Managed Server', qty: 1 },
    { service: 'Managed Firewall', qty: 1 },
  ];
  await addContract('hdMsa', {
    name: 'Managed Services — Essentials',
    companyId: C.hd,
    type: 'recurring',
    status: 'active',
    startDate: firstOfMonth(10),
    slaId: need(slaIds, 'Standard SLA', 'SLA policy'),
    contactId: contact('hd', 'Katrien Vermeersch').id,
    isDefault: true,
    recurringAmount: sumServices(hdServices),
    billingPeriod: 'monthly',
    overageRate: 95,
    description: 'Managed workstations, practice server and firewall. Patching only outside clinic hours.',
    createdAt: addDays(now, -310),
  });
  await tx.insert(s.contractServices).values(hdServices.map((x) => ({ contractId: K.hdMsa.id, serviceId: svc(x.service).id, quantity: x.qty, unitPrice: svc(x.service).unitPrice, startDate: K.hdMsa.startDate })));
  await addContract('afRetainer', {
    name: 'Support Retainer (6 h / month)',
    companyId: C.af,
    type: 'retainer',
    status: 'active',
    startDate: firstOfMonth(14),
    slaId: need(slaIds, 'Standard SLA', 'SLA policy'),
    contactId: contact('af', 'Mark de Boer').id,
    isDefault: true,
    recurringAmount: 540,
    hourlyRate: 95,
    billingPeriod: 'monthly',
    description: 'Monthly retainer covering up to 6 hours of support; overage billed at the hourly rate.',
    createdAt: addDays(now, -430),
  });
  log(`Created ${Object.keys(K).length} contracts`);

  /* ------------------------------------------------------------ projects */
  const projectNumber = async () => formatNumber(settings.projectPrefix, await nextSequence(tx, 'project'));
  type TaskSeed = { title: string; who: UserKey; status: 'todo' | 'in_progress' | 'blocked' | 'done'; est: number; start: number; due: number; ms: number; worked?: number[] };
  const P = {} as Record<'m365' | 'wifi' | 'srv2016', number>;
  const taskIds: { id: number; who: UserKey; worked: number[]; title: string; project: 'm365' | 'wifi' | 'srv2016' }[] = [];
  const addProject = async (
    key: keyof typeof P,
    v: Omit<typeof s.projects.$inferInsert, 'projectNumber'>,
    milestones: { name: string; due: number; done: boolean }[],
    tasks: TaskSeed[],
  ) => {
    const [p] = await tx.insert(s.projects).values({ ...v, projectNumber: await projectNumber() }).returning();
    P[key] = p!.id;
    const ms = await tx
      .insert(s.projectMilestones)
      .values(milestones.map((m, i) => ({ projectId: p!.id, name: m.name, dueDate: isoDate(addDays(now, m.due)), isComplete: m.done, completedAt: m.done ? atLocal(m.due, 16) : null, sortOrder: i * 10, createdAt: v.createdAt })))
      .returning();
    const rows = await tx
      .insert(s.projectTasks)
      .values(
        tasks.map((t, i) => ({
          projectId: p!.id,
          milestoneId: ms[t.ms]?.id ?? null,
          title: t.title,
          assignedUserId: U[t.who],
          status: t.status,
          estimatedHours: t.est,
          startDate: isoDate(addDays(now, t.start)),
          dueDate: isoDate(addDays(now, t.due)),
          completedAt: t.status === 'done' ? atLocal(Math.min(t.due, -1), 16) : null,
          sortOrder: i * 10,
          createdAt: v.createdAt,
        })),
      )
      .returning();
    rows.forEach((r, i) => taskIds.push({ id: r.id, who: tasks[i]!.who, worked: tasks[i]!.worked ?? [], title: r.title, project: key }));
  };
  await addProject(
    'm365',
    {
      name: 'Microsoft 365 tenant migration',
      companyId: C.ns,
      contractId: K.nsMigration.id,
      managerId: U.tom,
      status: 'active',
      startDate: isoDate(addDays(now, -28)),
      endDate: isoDate(addDays(now, 21)),
      estimatedHours: 62,
      budget: 6900,
      description: 'Move Northstar from the legacy hosted Exchange and on-prem file shares to Microsoft 365 (Exchange Online, SharePoint, OneDrive, Intune).',
      createdAt: addDays(now, -32),
    },
    [
      { name: 'Discovery & planning', due: -18, done: true },
      { name: 'Pilot migration (5 users)', due: -5, done: true },
      { name: 'Full cutover', due: 10, done: false },
      { name: 'Hypercare & decommission', due: 21, done: false },
    ],
    [
      { title: 'Inventory mailboxes, shared mailboxes and distribution lists', who: 'tom', status: 'done', est: 4, start: -28, due: -24, ms: 0, worked: [-27, -25] },
      { title: 'Review licensing and assign Business Premium via groups', who: 'lucas', status: 'done', est: 2, start: -26, due: -22, ms: 0, worked: [-23] },
      { title: 'Configure Entra Connect cloud sync', who: 'lucas', status: 'done', est: 6, start: -22, due: -18, ms: 0, worked: [-21, -19] },
      { title: 'Verify domain and prepare DNS records', who: 'lucas', status: 'done', est: 2, start: -20, due: -17, ms: 0, worked: [-18] },
      { title: 'Migrate pilot group mailboxes (5 users)', who: 'tom', status: 'done', est: 6, start: -14, due: -8, ms: 1, worked: [-13, -11, -9] },
      { title: 'Pilot user feedback and fixes', who: 'noor', status: 'done', est: 3, start: -9, due: -5, ms: 1, worked: [-7, -6] },
      { title: 'Migrate file shares from NS-FS01 to SharePoint', who: 'tom', status: 'in_progress', est: 14, start: -8, due: 5, ms: 2, worked: [-6, -4, -2, -1] },
      { title: 'Migrate remaining 20 mailboxes', who: 'tom', status: 'in_progress', est: 10, start: -3, due: 8, ms: 2, worked: [-3, -1] },
      { title: 'Deploy Outlook and Teams configuration via Intune', who: 'lucas', status: 'blocked', est: 6, start: -2, due: 9, ms: 2, worked: [-2] },
      { title: 'User training session and cutover communication', who: 'noor', status: 'todo', est: 3, start: 6, due: 10, ms: 2 },
      { title: 'Decommission legacy mail platform', who: 'tom', status: 'todo', est: 4, start: 14, due: 21, ms: 3 },
    ],
  );
  await addProject(
    'wifi',
    {
      name: 'Warehouse Wi-Fi refresh',
      companyId: C.bp,
      contractId: K.bpBlock.id,
      managerId: U.lucas,
      status: 'planning',
      startDate: isoDate(addDays(now, 14)),
      endDate: isoDate(addDays(now, 60)),
      estimatedHours: 32,
      budget: 9800,
      description: 'Replace the end-of-life UniFi AC Pro access points in the Mechelen warehouse with Wi-Fi 6 APs, new PoE switch and a scanner-optimised SSID design.',
      createdAt: addDays(now, -20),
    },
    [
      { name: 'Site survey & design', due: 18, done: false },
      { name: 'Installation & go-live', due: 45, done: false },
    ],
    [
      { title: 'Predictive design and scoping call', who: 'lucas', status: 'done', est: 2, start: -6, due: -4, ms: 0, worked: [-5] },
      { title: 'On-site heat-map survey Mechelen warehouse', who: 'lucas', status: 'todo', est: 6, start: 14, due: 16, ms: 0 },
      { title: 'Order access points and PoE switch', who: 'tom', status: 'todo', est: 1, start: 18, due: 20, ms: 1 },
      { title: 'Install 8 × Wi-Fi 6 access points', who: 'tom', status: 'todo', est: 12, start: 30, due: 38, ms: 1 },
      { title: 'Configure SSIDs and VLANs for scanners', who: 'lucas', status: 'todo', est: 6, start: 36, due: 40, ms: 1 },
      { title: 'Handheld scanner roaming test with warehouse team', who: 'noor', status: 'todo', est: 4, start: 40, due: 45, ms: 1 },
    ],
  );
  await addProject(
    'srv2016',
    {
      name: 'Server 2016 retirement',
      companyId: C.mt,
      contractId: K.mtSrv.id,
      managerId: U.lucas,
      status: 'completed',
      startDate: isoDate(addDays(now, -80)),
      endDate: isoDate(addDays(now, -9)),
      estimatedHours: 40,
      budget: 8500,
      description: 'Replace MT-SRV-01 / MT-SRV-02 (Windows Server 2016, end of support) with a new Hyper-V host and modern VMs.',
      completedAt: atLocal(-9, 16),
      createdAt: addDays(now, -86),
    },
    [
      { name: 'New host in production', due: -50, done: true },
      { name: 'Workloads migrated', due: -20, done: true },
      { name: 'Old servers decommissioned', due: -9, done: true },
    ],
    [
      { title: 'Build MT-HV-01 Hyper-V host', who: 'lucas', status: 'done', est: 8, start: -78, due: -70, ms: 0 },
      { title: 'Migrate AD DS to MT-DC01 and raise functional level', who: 'lucas', status: 'done', est: 6, start: -60, due: -50, ms: 0 },
      { title: 'Move file shares to MT-NAS-01', who: 'tom', status: 'done', est: 8, start: -45, due: -30, ms: 1, worked: [-29] },
      { title: 'Migrate build agents to MT-BUILD01', who: 'lucas', status: 'done', est: 8, start: -30, due: -20, ms: 1, worked: [-28, -26, -22] },
      { title: 'Decommission MT-SRV-01 / MT-SRV-02 and wipe disks', who: 'tom', status: 'done', est: 4, start: -15, due: -10, ms: 2, worked: [-14, -12] },
      { title: 'Update documentation and hand-over', who: 'lucas', status: 'done', est: 2, start: -11, due: -9, ms: 2, worked: [-10] },
    ],
  );
  log('Created 3 projects with milestones and tasks');

  /* --------------------------------------------------------- knowledge */
  const kbIds = new Map<string, number>();
  for (const a of KB) {
    const created = addDays(now, -a.daysAgo);
    const [row] = await tx
      .insert(s.kbArticles)
      .values({
        articleNumber: formatNumber(settings.kbPrefix, await nextSequence(tx, 'kb')),
        title: a.title,
        body: a.body.join('\n'),
        categoryId: a.category ? need(kbCatIds, a.category, 'KB category') : null,
        companyId: a.company ? C[a.company] : null,
        tags: a.tags,
        visibility: a.visibility,
        status: a.status,
        authorId: U[a.author],
        updatedById: U[a.author],
        views: a.status === 'published' ? rng.int(8, 240) : 0,
        publishedAt: a.status === 'published' ? addDays(created, 1) : null,
        createdAt: created,
        updatedAt: addDays(created, a.status === 'published' ? rng.int(1, Math.max(1, Math.floor(a.daysAgo / 2))) : 0),
      })
      .returning();
    kbIds.set(a.key, row!.id);
  }
  log(`Created ${KB.length} knowledge base articles`);

  /* ------------------------------------------------------------ tickets */
  interface PendingTime {
    userId: number;
    ticketId?: number;
    taskId?: number;
    end: Date;
    minutes: number;
    description: string;
    workTypeId: number;
  }
  const pendingTime: PendingTime[] = [];
  const ticketKeys = new Map<string, number>();
  const kbLinks: { articleId: number; ticketId: number; at: Date }[] = [];
  const relationRows: (typeof s.ticketRelations.$inferInsert)[] = [];
  let ticketCount = 0;

  /** Backdates events/notifications that the ticket service wrote with the transaction's now(). */
  const stamp = async (ticketId: number, at: Date) => {
    await tx.update(s.ticketEvents).set({ createdAt: at }).where(and(eq(s.ticketEvents.ticketId, ticketId), sql`${s.ticketEvents.createdAt} = now()`));
    await tx
      .update(s.notifications)
      .set({ createdAt: at })
      .where(and(eq(s.notifications.entityType, 'ticket'), eq(s.notifications.entityId, ticketId), sql`${s.notifications.createdAt} = now()`));
  };
  const ctxAt = (userId: number | null, at: Date): TicketCtx => ({ db: tx, userId, now: at });

  const respondRange: Record<Prio, [number, number]> = { Critical: [5, 20], High: [10, 40], Medium: [15, 110], Low: [30, 300] };

  const playTicket = async (spec: TicketSpec) => {
    const co = spec.co;
    const contactInfo = spec.contact ? contact(co, spec.contact) : null;
    let ciId: number | null = null;
    if (spec.ci === 'device') ciId = contactInfo ? (deviceOfContact.get(contactInfo.id) ?? null) : null;
    else if (spec.ci) ciId = ci(spec.ci).id;
    const alert = spec.source === 'Monitoring Alert';
    const tech = spec.tech ? U[spec.tech] : null;
    const first = contactInfo?.first ?? '';

    // Creation time: alerts may arrive any time, people during office hours.
    const hour = spec.hour ?? rng.int(8, 16);
    const minute = spec.minute ?? rng.int(0, 59);
    let created: Date;
    if (spec.days < 1) {
      created = new Date(now.getTime() - Math.max(spec.days * DAY, 20 * MIN));
    } else {
      created = atLocal(-Math.round(spec.days), hour, minute);
      if (!alert) created = bizShift(created);
    }
    const minRunway = spec.outcome === 'new' ? 10 * MIN : 3 * 60 * MIN;
    if (created.getTime() > now.getTime() - minRunway) created = new Date(now.getTime() - minRunway - rng.int(5, 40) * MIN);

    const preAssign = !!tech && (spec.outcome === 'new' || (!alert && rng.chance(0.65)));
    const creatorId = ['Email', 'Portal', 'Monitoring Alert'].includes(spec.source) ? null : spec.internal ? (tech ?? U.sarah) : rng.pick([U.noor, U.sarah, tech ?? U.noor]);
    const projectId = spec.project ? P[spec.project === 'm365' ? 'm365' : 'srv2016'] : null;
    const contractId = spec.project === 'm365' ? K.nsMigration.id : spec.project === 'srv2016' ? K.mtSrv.id : null;
    const queueName = spec.queue ?? (alert ? 'Monitoring Alerts' : 'Service Desk');

    const input: TicketInput = {
      title: spec.title,
      description: spec.desc,
      companyId: C[co],
      contactId: contactInfo?.id ?? null,
      configurationItemId: ciId,
      assignedUserId: preAssign ? tech : null,
      queueId: queue(queueName),
      ticketTypeId: need(typeIds, spec.type, 'ticket type'),
      issueTypeId: spec.issue ? need(issueIds, spec.issue, 'issue type') : null,
      subIssueTypeId: spec.issue && spec.sub ? need(subIds, `${spec.issue}/${spec.sub}`, 'sub-issue type') : null,
      statusId: st('New'),
      priorityId: need(prioIds, spec.prio, 'priority'),
      sourceId: need(sourceIds, spec.source, 'ticket source'),
      contractId,
      projectId,
      tags: spec.tags ?? [],
    };
    const ticket = await createTicket(ctxAt(creatorId, created), input);
    const id = ticket.id;
    ticketCount++;
    await stamp(id, created);
    if (spec.key) ticketKeys.set(spec.key, id);
    const watchers = new Set<number>((spec.watchers ?? []).map((w) => U[w]));
    if (spec.prio === 'Critical') watchers.add(U.sarah);
    if (tech) watchers.delete(tech);
    if (watchers.size) await tx.insert(s.ticketWatchers).values([...watchers].map((userId) => ({ ticketId: id, userId, createdAt: created })));
    for (const k of spec.kb ?? []) kbLinks.push({ articleId: need(kbIds, k, 'KB article'), ticketId: id, at: created });
    if (spec.relate) relationRows.push({ ticketId: id, relatedTicketId: need(ticketKeys, spec.relate.key, 'ticket key'), type: spec.relate.type, createdAt: created });

    if (spec.outcome === 'new' || !tech) return;

    let t = created;
    /** Advances the clock; mandatory steps are squeezed before `cutoff`, optional ones are skipped. */
    const step = async (minutes: number, fn: (at: Date) => Promise<unknown>, mandatory = true, office = true): Promise<boolean> => {
      let next = addMinutes(t, minutes);
      if (office && !alert) next = bizShift(next);
      if (next > cutoff) {
        if (!mandatory) return false;
        next = new Date(t.getTime() + (cutoff.getTime() - t.getTime()) / 2);
      }
      t = next;
      await fn(t);
      await stamp(id, t);
      return true;
    };
    const work = (minutes: number, description: string, userId = tech) =>
      pendingTime.push({
        userId,
        ticketId: id,
        end: t,
        minutes,
        description: description.length > 180 ? `${description.slice(0, 177)}…` : description,
        workTypeId: workType(spec.internal && co === 'lumen' ? 'Internal / Admin' : spec.project ? 'Project Work' : spec.onsite ? 'Onsite Support' : 'Remote Support'),
      });

    if (!preAssign) await step(rng.int(5, 40), (at) => updateTicket(ctxAt(U.sarah, at), id, { assignedUserId: tech }), true, false);

    // First response.
    const slow = spec.slow ?? (spec.prio !== 'Critical' && rng.chance(0.08));
    const [lo, hi] = slow ? [360, 1300] : respondRange[spec.prio];
    await step(rng.int(lo, hi), (at) =>
      alert || !contactInfo
        ? addTicketNote(ctxAt(tech, at), id, { body: 'Alert acknowledged — investigating.', visibility: 'internal', statusId: st('In Progress') })
        : addTicketNote(ctxAt(tech, at), id, { body: rng.pick(ACKS).replace('{first}', first), visibility: 'public', statusId: st('In Progress') }),
    );

    // Troubleshooting notes (each with logged time).
    for (const note of spec.steps ?? []) {
      const ok = await step(rng.int(20, 120), (at) => addTicketNote(ctxAt(tech, at), id, { body: note, visibility: 'internal' }), false);
      if (!ok) break;
      work(rng.step(15, spec.prio === 'Critical' ? 120 : 75), note);
    }

    switch (spec.outcome) {
      case 'in_progress':
        return;
      case 'waiting_customer':
        await step(rng.int(5, 30), (at) =>
          addTicketNote(ctxAt(tech, at), id, {
            body: spec.ask ?? `Hi ${first}, could you let me know when would be a good moment for a short remote session to test this together?`,
            visibility: 'public',
            statusId: st('Waiting for Customer'),
          }),
        );
        work(rng.step(15, 30), `Follow-up with customer: ${spec.title}`);
        return;
      case 'waiting_vendor':
        await step(rng.int(10, 60), (at) =>
          addTicketNote(ctxAt(tech, at), id, { body: spec.vendor ?? 'Case opened with the vendor; waiting for their response.', visibility: 'internal', statusId: st('Waiting for Vendor') }),
        );
        work(rng.step(15, 45), `Vendor case: ${spec.title}`);
        return;
      case 'scheduled':
        await step(rng.int(10, 60), (at) =>
          addTicketNote(ctxAt(tech, at), id, { body: spec.schedule ?? `Hi ${first}, we have scheduled a visit to handle this.`, visibility: 'public', statusId: st('Scheduled') }),
        );
        work(rng.step(15, 30), `Planning: ${spec.title}`);
        return;
      case 'escalated':
        await step(rng.int(15, 90), async (at) => {
          await addTicketNote(ctxAt(tech, at), id, { body: spec.escalate ?? 'Escalating to Level 2 for further analysis.', visibility: 'internal' });
          await updateTicket(ctxAt(tech, at), id, { statusId: st('Escalated'), queueId: queue('Level 2 Support'), assignedUserId: U.lucas });
        });
        work(rng.step(15, 45), `Escalation analysis: ${spec.title}`);
        return;
      default:
        break;
    }

    // Resolved / closed path, sometimes via a round-trip with the customer.
    if (contactInfo && rng.chance(0.3)) {
      await step(rng.int(10, 40), (at) =>
        addTicketNote(ctxAt(tech, at), id, {
          body: `Hi ${first}, could you confirm whether the problem still occurs after the change I just made?`,
          visibility: 'public',
          statusId: st('Waiting for Customer'),
        }),
      );
      await step(rng.int(180, 1800), (at) => addTicketNote(ctxAt(tech, at), id, { body: rng.pick(CUSTOMER_REPLIES), visibility: 'internal', statusId: st('In Progress') }));
    }
    const resolution = spec.resolution ?? 'Issue resolved.';
    await step(rng.int(20, 240), async (at) => {
      await updateTicket(ctxAt(tech, at), id, { statusId: st('Resolved'), resolution });
      await addTicketNote(ctxAt(tech, at), id, {
        body: contactInfo && !alert ? `Hi ${first}, ${resolution} I am marking this ticket as resolved — just reply if anything is still not right.` : resolution,
        visibility: contactInfo && !alert ? 'public' : 'internal',
        kind: 'resolution',
      });
    });
    work(rng.step(15, spec.steps?.length ? 45 : 60), `Resolution: ${resolution}`);

    if (spec.outcome === 'closed') {
      await step(rng.int(2 * 1440, 3 * 1440), (at) => updateTicket(ctxAt(U.sarah, at), id, { statusId: st('Closed') }), false);
    }
  };

  for (const spec of TICKETS) await playTicket(spec);

  // Generic tickets to fill the queue (deterministic thanks to the seeded PRNG).
  const coWeights: CoKey[] = ['ns', 'ns', 'ns', 'ns', 'bp', 'bp', 'mt', 'mt', 'hd', 'af', 'af'];
  const fleetOf = (co: CoKey, pred: (r: CiRow) => boolean) => [...CI.values()].filter((r) => r.companyId === C[co] && r.lifecycleStatus === 'active' && pred(r));
  const typeName = new Map([...ciTypeIds.entries()].map(([k, v]) => [v, k]));
  for (let i = 0; i < 26; i++) {
    const g = GENERIC[i % GENERIC.length]!;
    const co = rng.pick(coWeights);
    const people = contactsOf[co].filter((c) => c.active && deviceOfContact.has(c.id));
    const person = rng.pick(people);
    let ciName: string | undefined;
    if (g.ci === 'device') ciName = [...CI.values()].find((r) => r.id === deviceOfContact.get(person.id))?.name;
    const pickName = (rows: CiRow[]) => (rows.length ? rng.pick(rows).name : undefined);
    if (g.ci === 'server') ciName = pickName(fleetOf(co, (r) => ['Server', 'Virtual Machine', 'NAS'].includes(typeName.get(r.ciTypeId) ?? '')));
    if (g.ci === 'printer') ciName = pickName(fleetOf(co, (r) => typeName.get(r.ciTypeId) === 'Printer'));
    const days = Math.round(rng.float() * 44 * 10) / 10;
    const roll = rng.float();
    const outcome: Outcome =
      days > 7
        ? roll < 0.8
          ? 'closed'
          : roll < 0.95
            ? 'resolved'
            : 'waiting_customer'
        : days > 2
          ? roll < 0.3
            ? 'closed'
            : roll < 0.65
              ? 'resolved'
              : roll < 0.85
                ? 'in_progress'
                : 'waiting_customer'
          : roll < 0.4
            ? 'new'
            : roll < 0.8
              ? 'in_progress'
              : 'resolved';
    const tech: UserKey | null = outcome === 'new' && rng.chance(0.5) ? null : g.alert ? rng.pick<UserKey>(['lucas', 'noor']) : rng.pick<UserKey>(['noor', 'noor', 'noor', 'lucas', 'tom', 'sarah']);
    await playTicket({
      co,
      title: g.title(person.first, person.last),
      desc: g.desc,
      type: g.type,
      issue: g.issue,
      sub: g.sub,
      prio: g.prio,
      source: g.source,
      contact: g.alert && g.ci === 'server' ? null : `${person.first} ${person.last}`,
      ci: ciName,
      days,
      outcome,
      tech,
      steps: g.steps,
      resolution: g.resolution,
      tags: g.tags,
      kb: g.kb,
    });
  }
  if (relationRows.length) await tx.insert(s.ticketRelations).values(relationRows);
  if (kbLinks.length) await tx.insert(s.kbArticleTickets).values(kbLinks.map((k) => ({ articleId: k.articleId, ticketId: k.ticketId, createdAt: k.at }))).onConflictDoNothing();
  log(`Created ${ticketCount} tickets with notes, lifecycle events, watchers and relations`);

  /* --------------------------------------------------------------- time */
  for (const task of taskIds) {
    for (const d of task.worked) {
      const end = atLocal(d, rng.int(11, 17), rng.pick([0, 15, 30, 45]));
      if (end > cutoff) continue;
      pendingTime.push({
        userId: U[task.who],
        taskId: task.id,
        end,
        minutes: rng.step(30, 180, 15),
        description: task.title,
        workTypeId: workType('Project Work'),
      });
    }
  }
  const timeValues: (typeof s.timeEntries.$inferInsert)[] = [];
  const thirtyDaysAgo = addDays(now, -30);
  for (const p of pendingTime) {
    const minutes = Math.min(180, Math.max(15, p.minutes));
    const startedAt = new Date(p.end.getTime() - minutes * MIN);
    if (startedAt < thirtyDaysAgo) continue;
    const tc = await resolveTimeContext(tx, p.ticketId ?? null, p.taskId ?? null);
    const cls = await classifyTime(tx, tc.contractId, p.workTypeId, undefined, { startedAt, durationMinutes: minutes });
    const recent = p.end > addDays(now, -3);
    const approvedAt = recent ? null : new Date(Math.min(addDays(p.end, 1).getTime(), cutoff.getTime()));
    timeValues.push({
      userId: p.userId,
      ticketId: p.ticketId ?? null,
      projectTaskId: p.taskId ?? null,
      companyId: tc.companyId,
      projectId: tc.projectId,
      contractId: tc.contractId,
      workTypeId: p.workTypeId,
      startedAt,
      endedAt: p.end,
      durationMinutes: minutes,
      billable: cls.billable,
      contractCovered: cls.contractCovered,
      coveredMinutes: cls.coveredMinutes,
      hourlyRate: cls.hourlyRate,
      description: p.description,
      status: recent ? 'submitted' : 'approved',
      approvedById: recent ? null : U.sarah,
      approvedAt,
      createdAt: p.end,
      updatedAt: approvedAt ?? p.end,
    });
  }
  if (timeValues.length) await tx.insert(s.timeEntries).values(timeValues);
  // Block contracts cover only up to the purchased hours.
  await recomputeCoverage(tx, [...new Set(timeValues.map((t) => t.contractId ?? null))]);
  const emmaTicket = ticketKeys.get('emma-slow');
  if (emmaTicket) {
    await tx.insert(s.activeTimers).values({ userId: U.lucas, ticketId: emmaTicket, description: 'Disk clean-up and post-reboot check', startedAt: new Date(now.getTime() - 25 * MIN) });
  }
  log(`Created ${timeValues.length} time entries`);

  /* ------------------------------------------------- CRM & scheduling */
  await tx.insert(s.opportunities).values([
    { companyId: C.ns, contactId: contact('ns', 'Pieter Claes').id, ownerId: U.sarah, title: 'Intune device management rollout', stage: 'proposal', amount: 4800, probability: 60, expectedCloseDate: isoDate(addDays(now, 30)), description: 'Follow-up to the Microsoft 365 migration: Autopilot, compliance policies and app deployment for 25 laptops.', createdAt: addDays(now, -10) },
    { companyId: C.bp, contactId: contact('bp', 'Karel Vos').id, ownerId: U.tom, title: 'Warehouse Wi-Fi refresh', stage: 'won', amount: 9800, probability: 100, expectedCloseDate: isoDate(addDays(now, -20)), closedAt: addDays(now, -20), description: '8 × Wi-Fi 6 APs, PoE switch and installation (see project).', createdAt: addDays(now, -45) },
    { companyId: C.bp, contactId: contact('bp', 'Karel Vos').id, ownerId: U.sarah, title: 'BP-HV-01 replacement or warranty extension', stage: 'negotiation', amount: 11200, probability: 70, expectedCloseDate: isoDate(addDays(now, 10)), description: 'Option A: 3-year warranty extension. Option B: new host + Server 2025 licensing + migration.', createdAt: addDays(now, -4) },
    { companyId: C.cl, contactId: contact('cl', 'Gilles Renard').id, ownerId: U.sarah, title: 'Managed Services Agreement (12 workstations)', stage: 'qualification', amount: 14400, probability: 20, expectedCloseDate: isoDate(addDays(now, 60)), description: 'Annual value. Heavy CAD workstations; interested in backup and Microsoft 365 management.', createdAt: addDays(now, -6) },
    { companyId: C.mt, contactId: contact('mt', 'Pim van den Berg').id, ownerId: U.sarah, title: 'Security awareness training programme', stage: 'lost', amount: 3200, probability: 0, expectedCloseDate: isoDate(addDays(now, -40)), closedAt: addDays(now, -38), description: 'Lost — customer chose an in-house programme.', createdAt: addDays(now, -70) },
    { companyId: C.af, contactId: contact('af', 'Helen Alder').id, ownerId: U.tom, title: 'Document management backup & DR upgrade', stage: 'negotiation', amount: 6200, probability: 70, expectedCloseDate: isoDate(addDays(now, 21)), description: 'Offsite immutable backups for AF-NAS-01 and a documented DR test.', createdAt: addDays(now, -15) },
  ]);
  await tx.insert(s.activities).values([
    { companyId: C.ns, contactId: contact('ns', 'Pieter Claes').id, userId: U.sarah, type: 'meeting', subject: 'Quarterly business review', body: 'Reviewed SLA performance (98 % on time), migration project status and Intune proposal. Pieter wants a decision before year-end.', occurredAt: atLocal(-12, 14) },
    { companyId: C.ns, contactId: contact('ns', 'Charlotte Dubois').id, userId: U.tom, type: 'call', subject: 'Migration cutover planning', body: 'Agreed cutover weekend and training session date. Charlotte will send the user communication.', occurredAt: atLocal(-3, 10, 30) },
    { companyId: C.bp, contactId: contact('bp', 'Karel Vos').id, userId: U.tom, type: 'call', subject: 'Wi-Fi refresh scope', body: 'Scanners in aisles 7–12 are the priority. Budget approved for 8 APs.', occurredAt: atLocal(-21, 11) },
    { companyId: C.bp, contactId: contact('bp', 'Karel Vos').id, userId: U.sarah, type: 'email', subject: 'Server warranty options sent', body: 'Sent options A and B for BP-HV-01 with pricing.', occurredAt: atLocal(-4, 15) },
    { companyId: C.mt, contactId: contact('mt', 'Pim van den Berg').id, userId: U.lucas, type: 'note', subject: 'Server 2016 retirement project closed', body: 'Old servers wiped and collected for recycling; certificates of destruction added to documentation.', occurredAt: atLocal(-9, 16) },
    { companyId: C.hd, contactId: contact('hd', 'Katrien Vermeersch').id, userId: U.sarah, type: 'call', subject: 'Follow-up after practice software outage', body: 'Explained root cause and the change to update scheduling. Katrien satisfied.', occurredAt: atLocal(-5, 13) },
    { companyId: C.af, contactId: contact('af', 'Helen Alder').id, userId: U.tom, type: 'meeting', subject: 'Backup & DR discussion', body: 'Walked through immutable backup options; proposal to follow.', occurredAt: atLocal(-15, 10) },
    { companyId: C.cl, contactId: contact('cl', 'Gilles Renard').id, userId: U.sarah, type: 'email', subject: 'Introduction and discovery questionnaire', body: 'Sent discovery questionnaire and reference case (fictional).', occurredAt: atLocal(-5, 9, 30) },
    { companyId: C.cl, contactId: contact('cl', 'Marieke Smeets').id, userId: U.sarah, type: 'task', subject: 'Schedule site visit', body: 'Plan an on-site assessment of the CAD workstations.', occurredAt: atLocal(-1, 11) },
  ]);

  const serviceCalls: { title: string; description: string; co: CoKey; start: Date; minutes: number; status: string; users: UserKey[]; ticket?: string }[] = [
    { title: 'Hand over laptop to new starter', description: 'Clara Nowak first day: laptop hand-over, MFA registration and Outlook/Teams walkthrough.', co: 'ns', start: businessDay(1, 9), minutes: 90, status: 'scheduled', users: ['noor'], ticket: 'ns-onboarding' },
    { title: 'After-hours patching: X-ray workstation', description: 'Install pending Windows updates on HD-DESK-04 after clinic hours.', co: 'hd', start: businessDay(2, 18, 30), minutes: 90, status: 'scheduled', users: ['tom'], ticket: 'hd-xray' },
    { title: 'Warehouse Wi-Fi interim fix & pre-survey', description: 'Temporary AP for aisles 7–12 and walk-through for the refresh project.', co: 'bp', start: businessDay(3, 13), minutes: 180, status: 'scheduled', users: ['lucas', 'tom'], ticket: 'bp-scanners' },
    { title: 'Monthly onsite visit', description: 'Regular onsite day at Northstar: walk-up questions and hardware checks.', co: 'ns', start: atLocal(-1, 9), minutes: 240, status: 'completed', users: ['noor'] },
  ];
  for (const scall of serviceCalls) {
    const [row] = await tx
      .insert(s.serviceCalls)
      .values({ title: scall.title, description: scall.description, companyId: C[scall.co], startAt: scall.start, endAt: addMinutes(scall.start, scall.minutes), status: scall.status, createdById: U.sarah, createdAt: addDays(now, -2) })
      .returning();
    await tx.insert(s.serviceCallUsers).values(scall.users.map((u) => ({ serviceCallId: row!.id, userId: U[u] })));
    const tid = scall.ticket ? ticketKeys.get(scall.ticket) : undefined;
    if (tid) await tx.insert(s.serviceCallTickets).values({ serviceCallId: row!.id, ticketId: tid });
  }

  await tx.insert(s.expenses).values([
    { userId: U.tom, companyId: C.bp, ticketId: ticketKeys.get('bp-scanners') ?? null, contractId: K.bpBlock.id, billingCodeId: billingIds.get('EXP-TRV') ?? null, expenseDate: isoDate(addDays(now, -2)), description: 'Mileage Brussels – Mechelen warehouse (2 × 31 km)', amount: 25.42, billable: true },
    { userId: U.lucas, companyId: C.ns, projectId: P.m365, contractId: K.nsMigration.id, billingCodeId: billingIds.get('EXP-MAT') ?? null, expenseDate: isoDate(addDays(now, -11)), description: 'USB-C docking station for pilot user', amount: 189, billable: true },
    { userId: U.noor, companyId: C.hd, contractId: K.hdMsa.id, billingCodeId: billingIds.get('EXP-TRV') ?? null, expenseDate: isoDate(addDays(now, -35)), description: 'Train ticket Brussels – Leuven (onsite SSD replacement)', amount: 14.2, billable: false },
  ]);

  /* --------------------------------------------------------- automation */
  await tx.insert(s.workflowRules).values([
    {
      name: 'Critical tickets → Level 2 Support',
      description: 'Routes every new Critical ticket to Level 2, tags it and notifies the service desk manager.',
      trigger: 'ticket.created',
      conditions: [{ field: 'priorityId', operator: 'eq', value: need(prioIds, 'Critical', 'priority') }],
      actions: [
        { type: 'set_queue', value: queue('Level 2 Support') },
        { type: 'add_tag', value: 'critical' },
        { type: 'notify_user', value: U.sarah },
      ],
      isActive: true,
      sortOrder: 10,
      createdById: actorId,
      createdAt: addDays(now, -120),
    },
    {
      name: 'Waiting for Customer > 3 days → reminder',
      description: 'Adds an internal reminder and notifies the assignee when a ticket has waited 3 days for the customer.',
      trigger: 'ticket.status_age',
      delayMinutes: 3 * 24 * 60,
      conditions: [{ field: 'statusId', operator: 'eq', value: st('Waiting for Customer') }],
      actions: [
        { type: 'add_note', value: 'Reminder: this ticket has been waiting for the customer for 3 days. Follow up or close it according to the policy.' },
        { type: 'notify_assignee', value: null },
      ],
      isActive: true,
      sortOrder: 20,
      createdById: actorId,
      createdAt: addDays(now, -120),
    },
    {
      name: 'Monitoring alerts → Monitoring Alerts queue',
      description: 'Keeps monitoring-generated tickets in their own queue and tags them.',
      trigger: 'ticket.created',
      conditions: [{ field: 'sourceId', operator: 'eq', value: need(sourceIds, 'Monitoring Alert', 'ticket source') }],
      actions: [
        { type: 'set_queue', value: queue('Monitoring Alerts') },
        { type: 'add_tag', value: 'monitoring' },
      ],
      isActive: true,
      sortOrder: 30,
      createdById: actorId,
      createdAt: addDays(now, -90),
    },
  ]);

  // Queue default assignees (set after the ticket history so some tickets stay unassigned).
  await tx.update(s.queues).set({ defaultAssigneeId: U.lucas }).where(eq(s.queues.id, queue('Level 2 Support')));
  await tx.update(s.queues).set({ defaultAssigneeId: U.tom }).where(eq(s.queues.id, queue('Projects')));
  await tx.update(s.queues).set({ defaultAssigneeId: U.noor }).where(eq(s.queues.id, queue('Monitoring Alerts')));
  await tx.update(s.queues).set({ email: 'support@lumen-it.example' }).where(eq(s.queues.id, queue('Service Desk')));

  /* ------------------------------------------------- Action1 snapshot */
  const syncAt = new Date(now.getTime() - 35 * MIN);
  const orgs = [
    { externalId: 'demo-org-northstar', name: 'Northstar Consulting (demo)', co: 'ns' as CoKey },
    { externalId: 'demo-org-bluepeak', name: 'BluePeak Logistics (demo)', co: 'bp' as CoKey },
  ];
  const missingUpdates = (critical: number, other: number, osName: string | null) => {
    const items: Record<string, unknown>[] = [];
    const win = osName?.startsWith('Windows 11') ? 'Windows 11 Version 23H2' : 'Microsoft server operating system version 21H2';
    for (let i = 0; i < Math.min(critical, 3); i++) {
      const kbNo = `KB50999${String(10 + i * 7)}`;
      items.push({
        id: `demo_win_${kbNo.toLowerCase()}`,
        type: 'SoftwareRepositoryPackage',
        name: i === 0 ? `${isoDate(now).slice(0, 7)} Cumulative Update for ${win} (demo)` : `Security Update for ${win} (${kbNo}, demo)`,
        vendor: 'Microsoft',
        update_type: 'Windows',
        kb_number: kbNo,
        reboot_needed: 'Yes',
        versions: [{ version: 'Latest', security_severity: 'Critical', update_type: 'Security Updates', release_date: isoDate(addDays(now, -6 - i * 7)), approval_status: 'Approved' }],
      });
    }
    const apps = ['Example PDF Reader 25.1', 'Example Browser 130.0', 'Example Zip Utility 24.09', 'Example Runtime 8.0.10'];
    for (let i = 0; i < Math.min(other, apps.length); i++) {
      items.push({
        id: `demo_app_${slug(apps[i]!)}`,
        type: 'SoftwareRepositoryPackage',
        name: `${apps[i]} (demo)`,
        vendor: 'Example Software Ltd',
        update_type: 'App',
        reboot_needed: 'No',
        versions: [{ version: 'Latest', security_severity: i === 0 ? 'Important' : 'Moderate', update_type: 'Regular Updates', release_date: isoDate(addDays(now, -3 - i * 4)), approval_status: 'New' }],
      });
    }
    return items;
  };
  type EpSpec = { ci?: string; org: 0 | 1; name?: string; connected: boolean; online: 'SUCCESS' | 'WARNING' | 'ERROR'; seenMin: number; reboot: boolean; crit: number; other: number; user?: string; match: 'matched' | 'unmatched' | 'conflict' };
  const epSpecs: EpSpec[] = [
    { ci: 'NS-LAPTOP-014', org: 0, connected: true, online: 'ERROR', seenMin: 4, reboot: true, crit: 2, other: 5, user: 'emma.smith', match: 'matched' },
    { ci: 'NS-LAPTOP-002', org: 0, connected: true, online: 'SUCCESS', seenMin: 2, reboot: false, crit: 0, other: 0, user: 'charlotte.dubois', match: 'matched' },
    { ci: 'NS-LAPTOP-005', org: 0, connected: true, online: 'WARNING', seenMin: 7, reboot: false, crit: 0, other: 3, user: 'bram.janssens', match: 'matched' },
    { ci: 'NS-LAPTOP-007', org: 0, connected: false, online: 'WARNING', seenMin: 60 * 24 * 9, reboot: false, crit: 1, other: 2, user: 'daan.willems', match: 'matched' },
    { ci: 'NS-LAPTOP-009', org: 0, connected: true, online: 'SUCCESS', seenMin: 1, reboot: false, crit: 0, other: 1, user: 'mehdi.benali', match: 'matched' },
    { ci: 'NS-LAPTOP-016', org: 0, connected: true, online: 'WARNING', seenMin: 12, reboot: true, crit: 0, other: 2, user: 'victor.lemaire', match: 'matched' },
    { ci: 'NS-LAPTOP-020', org: 0, connected: true, online: 'SUCCESS', seenMin: 3, reboot: false, crit: 0, other: 0, user: 'kobe.michiels', match: 'matched' },
    { ci: 'NS-LAPTOP-024', org: 0, connected: false, online: 'ERROR', seenMin: 60 * 24 * 21, reboot: true, crit: 3, other: 4, user: 'oliver.hughes', match: 'matched' },
    { ci: 'NS-DC01', org: 0, connected: true, online: 'SUCCESS', seenMin: 1, reboot: false, crit: 0, other: 1, user: 'NORTHSTAR\\svc-backup', match: 'matched' },
    { ci: 'NS-FS01', org: 0, connected: true, online: 'WARNING', seenMin: 1, reboot: true, crit: 1, other: 0, user: 'NORTHSTAR\\svc-backup', match: 'matched' },
    { ci: 'BP-DESK-01', org: 1, connected: true, online: 'SUCCESS', seenMin: 5, reboot: false, crit: 0, other: 0, user: 'karel.vos', match: 'matched' },
    { ci: 'BP-DESK-02', org: 1, connected: true, online: 'WARNING', seenMin: 9, reboot: false, crit: 0, other: 2, user: 'ingrid.smets', match: 'matched' },
    { ci: 'BP-DESK-05', org: 1, connected: false, online: 'WARNING', seenMin: 60 * 24 * 3, reboot: false, crit: 0, other: 4, user: 'anouk.dewit', match: 'matched' },
    { ci: 'BP-LAPTOP-01', org: 1, connected: true, online: 'ERROR', seenMin: 15, reboot: true, crit: 2, other: 1, user: 'wout.aerts', match: 'matched' },
    { ci: 'BP-WMS01', org: 1, connected: true, online: 'SUCCESS', seenMin: 1, reboot: false, crit: 0, other: 2, user: 'BLUEPEAK\\svc-wms', match: 'matched' },
    { org: 0, name: 'NS-LAPTOP-026', connected: true, online: 'SUCCESS', seenMin: 30, reboot: false, crit: 0, other: 6, user: 'clara.nowak', match: 'unmatched' },
    { org: 1, name: 'BP-SCAN-STATION', connected: true, online: 'WARNING', seenMin: 18, reboot: false, crit: 1, other: 3, user: 'BLUEPEAK\\scanner', match: 'unmatched' },
    { org: 1, name: 'BP-WH-PC01', connected: true, online: 'SUCCESS', seenMin: 6, reboot: false, crit: 0, other: 1, user: 'stijn.coppens', match: 'conflict' },
  ];
  const epValues: (typeof s.action1Endpoints.$inferInsert)[] = epSpecs.map((e, i) => {
    const row = e.ci ? ci(e.ci) : null;
    const org = orgs[e.org]!;
    const name = row?.name ?? e.name!;
    const osName = row?.osName ? `${row.osName}${row.osVersion ? ` (${row.osVersion})` : ''}` : 'Windows 11 Pro (23H2)';
    const lastSeenAt = new Date(syncAt.getTime() - e.seenMin * MIN);
    const domain = e.org === 0 ? 'NORTHSTAR' : 'BLUEPEAK';
    const conflictCis = e.match === 'conflict' ? [ci('BP-WH-PC01'), ci('BP-WH-PC01 (old)')] : [];
    return {
      externalId: `demo-ep-${slug(org.externalId.replace('demo-org-', ''))}-${String(i + 1).padStart(3, '0')}`,
      orgExternalId: org.externalId,
      configurationItemId: e.match === 'matched' ? row!.id : null,
      contactId: e.match === 'matched' ? row!.contactId : null,
      name,
      deviceName: name,
      osName: row?.osName ? osName : 'Windows 11 Pro (23H2)',
      platform: 'Windows',
      serialNumber: row?.serialNumber ?? (e.match === 'unmatched' ? `DEMO${rng.chars(7)}` : null),
      manufacturer: row?.manufacturer ?? (e.match === 'unmatched' ? 'Dell Inc.' : 'HP'),
      ipAddress: row?.ipAddress ?? `10.${e.org === 0 ? '10' : '21'}.20.${200 + i}`,
      macAddress: row?.macAddress ?? macFor(),
      loggedInUser: e.user?.includes('\\') ? e.user : `${domain}\\${e.user ?? 'user'}`,
      agentStatus: e.connected ? 'Connected' : 'Disconnected',
      onlineStatus: e.online,
      lastSeenAt,
      lastBootAt: new Date(lastSeenAt.getTime() - rng.int(1, e.reboot ? 30 : 6) * DAY),
      rebootRequired: e.reboot,
      updateStatus: e.crit > 0 ? 'ERROR' : e.other > 0 ? 'WARNING' : 'SUCCESS',
      vulnerabilityStatus: e.crit > 1 ? 'ERROR' : e.crit > 0 || e.other > 2 ? 'WARNING' : 'SUCCESS',
      missingCriticalUpdates: e.crit,
      missingOtherUpdates: e.other,
      agentVersion: '5.302.1023.1',
      cpu: row?.cpu ?? 'Intel(R) Core(TM) i5-1335U',
      ramText: row?.ramGb ? `${row.ramGb}Gb` : '16Gb',
      diskText: row?.storageGb ? `${row.storageGb}Gb SSD` : '512Gb SSD',
      missingUpdates: e.crit + e.other > 0 ? missingUpdates(e.crit, e.other, row?.osName ?? 'Windows 11') : [],
      raw: { demo: true, note: 'Fictional Action1 snapshot created by the demo seed' },
      matchStatus: e.match,
      matchNote:
        e.match === 'matched'
          ? `Matched by serial number to ${row!.ciNumber}`
          : e.match === 'conflict'
            ? `${conflictCis.length} CIs in this company match by hostname: ${conflictCis.map((c) => c.ciNumber).join(', ')}`
            : 'No matching CI found',
      firstSeenAt: addDays(now, e.match === 'unmatched' ? -2 : -rng.int(30, 300)),
      lastSyncedAt: syncAt,
    };
  });
  await tx.insert(s.action1Endpoints).values(epValues);
  for (const [i, org] of orgs.entries()) {
    await tx.insert(s.action1Organizations).values({
      externalId: org.externalId,
      name: org.name,
      companyId: C[org.co],
      enabled: true,
      endpointCount: epSpecs.filter((e) => e.org === i).length,
      lastSyncedAt: syncAt,
      createdAt: addDays(now, -60),
    });
  }
  for (const e of epSpecs) {
    if (e.match !== 'matched' || !e.ci) continue;
    await tx
      .update(s.configurationItems)
      .set({ source: 'action1', lastSeenAt: new Date(syncAt.getTime() - e.seenMin * MIN) })
      .where(eq(s.configurationItems.id, ci(e.ci).id));
  }
  const runLog = (at: Date, entries: [string, string][]) => entries.map(([level, message], i) => ({ at: new Date(at.getTime() + i * 1500).toISOString(), level, message }));
  const baseStats = { orgs: 2, orgsSynced: 2, endpoints: epSpecs.length, newEndpoints: 0, created: 0, updated: 0, matched: 15, unmatched: 2, conflicts: 1, unmapped: 0, ignored: 0, errors: 0, missing: 0 };
  const run2At = new Date(now.getTime() - DAY - 2 * 60 * MIN);
  const run3At = new Date(now.getTime() - 2 * DAY - 35 * MIN);
  await tx.insert(s.syncRuns).values([
    {
      provider: 'action1',
      trigger: 'scheduled',
      status: 'success',
      startedAt: syncAt,
      finishedAt: new Date(syncAt.getTime() + 48_000),
      stats: { ...baseStats, updated: 4 },
      log: runLog(syncAt, [
        ['info', 'Demo data: this sync run was generated by the demo seed (no Action1 API was called).'],
        ['info', 'Found 2 Action1 organization(s)'],
        ['info', 'Organization "Northstar Consulting (demo)": 11 endpoints'],
        ['info', 'Organization "BluePeak Logistics (demo)": 7 endpoints'],
        ['warn', `Endpoint "BP-WH-PC01": 2 CIs in this company match by hostname (demo data)`],
        ['info', 'Sync finished: 15 matched, 2 need review, 1 conflict (demo data)'],
      ]),
    },
    {
      provider: 'action1',
      trigger: 'manual',
      status: 'partial',
      startedAt: run2At,
      finishedAt: new Date(run2At.getTime() + 95_000),
      stats: { ...baseStats, orgsSynced: 1, endpoints: 11, matched: 10, unmatched: 1, conflicts: 0, errors: 1, updated: 2 },
      log: runLog(run2At, [
        ['info', 'Demo data: this sync run was generated by the demo seed (no Action1 API was called).'],
        ['info', 'Found 2 Action1 organization(s)'],
        ['error', 'Organization "BluePeak Logistics (demo)": request timed out after 30 s (demo data)'],
        ['info', 'Sync finished with errors (demo data)'],
      ]),
      error: 'Organization "BluePeak Logistics (demo)": request timed out (demo data)',
      triggeredById: U.sarah,
    },
    {
      provider: 'action1',
      trigger: 'scheduled',
      status: 'success',
      startedAt: run3At,
      finishedAt: new Date(run3At.getTime() + 52_000),
      stats: { ...baseStats, newEndpoints: 1, unmatched: 1, updated: 6 },
      log: runLog(run3At, [
        ['info', 'Demo data: this sync run was generated by the demo seed (no Action1 API was called).'],
        ['info', 'Found 2 Action1 organization(s)'],
        ['info', 'New endpoint "BP-SCAN-STATION" needs review (demo data)'],
      ]),
    },
  ]);
  log(`Created Action1 demo snapshot: ${orgs.length} organizations, ${epValues.length} endpoints, 3 sync runs`);

  /* ----------------------------------------------- notifications & tidy */
  // Ticket-service notifications older than two days count as read.
  await tx
    .update(s.notifications)
    .set({ readAt: sql`${s.notifications.createdAt} + interval '2 hours'` })
    .where(and(inArray(s.notifications.userId, Object.values(U)), lt(s.notifications.createdAt, addDays(now, -2))));
  const breached = await tx
    .select({ id: s.tickets.id, number: s.tickets.ticketNumber, title: s.tickets.title })
    .from(s.tickets)
    .where(and(inArray(s.tickets.companyId, Object.values(C)), eq(s.tickets.firstResponseBreached, true)))
    .limit(2);
  await tx.insert(s.notifications).values([
    ...breached.map((b, i) => ({
      userId: U.sarah,
      type: 'ticket.sla_breached',
      title: `SLA breached on ${b.number}`,
      body: `The first response target for ${b.title} has been breached.`,
      link: `/tickets/${b.id}`,
      entityType: 'ticket',
      entityId: b.id,
      readAt: i === 0 ? null : addDays(now, -1),
      createdAt: addDays(now, -1 - i),
    })),
    { userId: U.sarah, type: 'integration', title: 'Action1 sync needs review', body: '2 endpoints need review and 1 conflict (demo data).', link: '/integrations/action1', createdAt: syncAt },
    { userId: U.sarah, type: 'time.approval', title: 'Time entries awaiting approval', body: 'Technicians submitted time entries in the last 3 days.', link: '/time', createdAt: new Date(now.getTime() - 3 * 60 * MIN) },
    { userId: U.lucas, type: 'workflow', title: 'Critical ticket routed to Level 2 Support', body: 'Workflow rule "Critical tickets → Level 2 Support" ran (demo).', link: '/tickets', createdAt: addDays(now, -6), readAt: addDays(now, -6) },
    { userId: U.tom, type: 'project', title: 'Task due soon: Migrate remaining 20 mailboxes', body: 'Microsoft 365 tenant migration (Northstar Consulting).', link: `/projects/${P.m365}`, entityType: 'project', entityId: P.m365, createdAt: new Date(now.getTime() - 5 * 60 * MIN) },
    { userId: U.noor, type: 'service_call', title: 'Service call tomorrow: hand over laptop to new starter', body: 'Northstar Consulting, 09:00.', link: '/schedule', createdAt: new Date(now.getTime() - 2 * 60 * MIN) },
  ]);
  // Keep record timestamps consistent with the backdated history.
  const demoTicketIds = sql`(select id from tickets where company_id in ${Object.values(C)})`;
  await tx.execute(sql`update tickets set updated_at = last_activity_at where company_id in ${Object.values(C)}`);
  await tx.execute(sql`update ticket_notes set updated_at = created_at where ticket_id in ${demoTicketIds}`);

  await tx.insert(s.auditLogs).values({
    userId: actorId,
    action: 'create',
    entityType: 'system',
    entityId: 'demo-seed',
    summary: 'Demo data seeded (fictional companies, tickets, time, projects, KB and Action1 snapshot) — development only',
    changes: { companies: COMPANIES.length, contacts: contactCount, configurationItems: CI.size, tickets: ticketCount, timeEntries: timeValues.length, kbArticles: KB.length, action1Endpoints: epValues.length },
    at: now,
  });
  log('Demo seed complete');

  return { users: userSpecs.map((u, i) => ({ email: emails[i]!, password: o.password, role: u.role })) };
}
