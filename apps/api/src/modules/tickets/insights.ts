/**
 * Ticket interpretation: when a ticket is created, Taskora reads the subject
 * and description (French and English) and adds an internal note for the
 * technician: what the request is about (laptop, printer, account / Active
 * Directory, e-mail, Microsoft 365, network, server, backup, security…), the
 * device it concerns (named in the text, or the requester's own device of
 * that kind, with its Action1 status), signs of urgency or wide impact,
 * similar past tickets of the company with their solution, repeat requests,
 * and first checks to do. A device named explicitly in the message is linked
 * to the ticket. Everything runs locally; no text leaves the server.
 */
import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { noteImagesToText } from '@taskora/shared';
import type { Db } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { getSystemSettings } from '../../lib/settings.js';
import { addTicketNote, updateTicket } from './service.js';

type Lang = 'en' | 'fr';

interface Topic {
  key: string;
  label: Record<Lang, string>;
  patterns: RegExp[];
  /** CI type names whose devices this topic is about. */
  ciTypes?: string[];
  checks: Record<Lang, string[]>;
}

const w = (src: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${src})(?=$|[^\\p{L}\\p{N}])`, 'iu');

export const TOPICS: Topic[] = [
  {
    key: 'computer',
    label: { en: 'Computer (laptop / desktop)', fr: 'Ordinateur (portable / fixe)' },
    patterns: [w('laptop|notebook|ordinateurs?|ordi|pc|portables?|desktop|poste de travail|écran|ecran|écrans|monitor|clavier|keyboard|souris|mouse|batterie|battery|chargeur|charger|écran bleu|blue screen|bsod|ne démarre pas|won.?t start|doesn.?t start|surchauffe|overheat|ventilateur|fan|lent|slow|freeze|plante|crash')],
    ciTypes: ['Laptop', 'Desktop'],
    checks: {
      en: ['Ask whether the device starts and what is on the screen (error message, photo).', 'Check Action1: last seen, pending restart, missing updates, disk space.', 'Try a restart and, if it is slow, look at disk space and startup programs.', 'If hardware is suspected, check the warranty end date before ordering parts.'],
      fr: ["Demander si l'appareil démarre et ce qui s'affiche (message d'erreur, photo).", 'Vérifier dans Action1 : dernière connexion, redémarrage en attente, mises à jour manquantes, espace disque.', "Tenter un redémarrage et, si c'est lent, vérifier l'espace disque et les programmes au démarrage.", 'En cas de panne matérielle, vérifier la fin de garantie avant de commander des pièces.'],
    },
  },
  {
    key: 'printer',
    label: { en: 'Printer / scanner', fr: 'Imprimante / scanner' },
    patterns: [w("imprimantes?|printers?|impressions?|imprimer|printing|print|scanners?|scans?|scanner|numériser|toner|cartouches?|cartridge|bourrage|paper jam|photocopieuse|copieur|copier|file d.?attente|spooler")],
    ciTypes: ['Printer'],
    checks: {
      en: ['Check the printer display for an error (paper, toner, jam) and that it is online.', 'Check the print queue on the PC (stuck jobs) and restart the spooler if needed.', 'Check the printer IP / network connection and the driver.', 'Scanning to e-mail or a folder: check the SMTP account or the shared folder rights.'],
      fr: ["Vérifier l'affichage de l'imprimante (papier, toner, bourrage) et qu'elle est en ligne.", "Vérifier la file d'attente sur le poste (travaux bloqués) et redémarrer le spouleur si besoin.", "Vérifier l'adresse IP / la connexion réseau de l'imprimante et le pilote.", 'Scan vers e-mail ou dossier : vérifier le compte SMTP ou les droits du dossier partagé.'],
    },
  },
  {
    key: 'account',
    label: { en: 'Account / password / Active Directory', fr: 'Compte / mot de passe / Active Directory' },
    patterns: [
      w('active directory|annuaire|comptes?|account|mot de passe|mots de passe|mdp|password|passwd|verrouillé|verrouille|locked|lockout|identifiants?|credentials?|login|log in|se connecter|connexion impossible|session|réinitialis|reset|mfa|2fa|double authentification|authenticator'),
      /(?:^|[^A-Za-z])AD(?:$|[^A-Za-z])/,
    ],
    checks: {
      en: ['Confirm the identity of the requester before any reset.', 'In Active Directory / Entra ID: is the account locked, disabled or expired? Last password change?', 'Reset the password or unlock the account and ask the user to sign in again.', 'MFA problem: check the registered methods; re-register the authenticator if the phone changed.'],
      fr: ["Vérifier l'identité du demandeur avant toute réinitialisation.", 'Dans Active Directory / Entra ID : le compte est-il verrouillé, désactivé ou expiré ? Date du dernier changement de mot de passe ?', "Réinitialiser le mot de passe ou déverrouiller le compte, puis demander à l'utilisateur de se reconnecter.", "Problème de MFA : vérifier les méthodes enregistrées ; réenregistrer l'authenticator si le téléphone a changé."],
    },
  },
  {
    key: 'email',
    label: { en: 'E-mail / Outlook', fr: 'Messagerie / Outlook' },
    patterns: [w("outlook|e-?mails?|courriels?|mails?|messagerie|boîte mail|boite mail|boîte aux lettres|mailbox|exchange|pièces? jointes?|attachments?|signature mail|ne reçois|n.?arrive pas|not receiving|cannot send|n.?envoie pas|boîte pleine|mailbox full")],
    checks: {
      en: ['Is it one user or everyone? Webmail (outlook.office.com) working?', 'Check the mailbox size / quota and the message trace in the admin center.', 'Outlook: restart, check the profile and the offline cache (OST).', 'Not receiving from someone: check spam / quarantine and the sender domain.'],
      fr: ['Un seul utilisateur ou tout le monde ? Le webmail (outlook.office.com) fonctionne-t-il ?', 'Vérifier la taille / le quota de la boîte et le suivi des messages dans le centre d’administration.', 'Outlook : redémarrer, vérifier le profil et le cache hors connexion (OST).', "Pas de réception d'un expéditeur : vérifier les spams / la quarantaine et le domaine de l'expéditeur."],
    },
  },
  {
    key: 'm365',
    label: { en: 'Microsoft 365 / Teams / OneDrive', fr: 'Microsoft 365 / Teams / OneDrive' },
    patterns: [w('office ?365|microsoft 365|m365|o365|teams|sharepoint|onedrive|licences?|licenses?|excel|word|powerpoint|office')],
    checks: {
      en: ['Check the user licence in the Microsoft 365 admin center.', 'Check the Microsoft 365 service health for an ongoing incident.', 'OneDrive / SharePoint: sync status, storage and sharing rights.'],
      fr: ["Vérifier la licence de l'utilisateur dans le centre d'administration Microsoft 365.", "Vérifier l'état des services Microsoft 365 (incident en cours).", 'OneDrive / SharePoint : état de la synchronisation, stockage et droits de partage.'],
    },
  },
  {
    key: 'network',
    label: { en: 'Network / Internet / Wi-Fi', fr: 'Réseau / Internet / Wi-Fi' },
    patterns: [w('réseau|reseau|network|wi-?fi|wlan|internet|connexion internet|pas d.?internet|no internet|vpn|switch|routeur|router|box|firewall|pare-?feu|câbles?|cables?|ethernet|prise réseau|dns|dhcp|adresse ip|ip address|débit|bandwidth|coupures?|déconnexions?|disconnect|latence|latency|ping')],
    ciTypes: ['Network Switch', 'Router', 'Firewall', 'Wireless Access Point'],
    checks: {
      en: ['One device, one room or the whole site? Wired, Wi-Fi or both?', 'Check the internet line / router and the firewall for alarms.', 'Check the switch port and the Wi-Fi access point of the area.', 'Ask for the IP address of the device (ipconfig) and test DNS.'],
      fr: ['Un appareil, une salle ou tout le site ? Filaire, Wi-Fi ou les deux ?', 'Vérifier la ligne internet / le routeur et les alertes du pare-feu.', "Vérifier le port du switch et le point d'accès Wi-Fi de la zone.", "Demander l'adresse IP de l'appareil (ipconfig) et tester le DNS."],
    },
  },
  {
    key: 'server',
    label: { en: 'Server / shared files', fr: 'Serveur / fichiers partagés' },
    patterns: [w('serveurs?|servers?|vm|machine virtuelle|virtual machine|hyper-?v|proxmox|vmware|esxi|nas|lecteur réseau|network drive|partage|shared drive|dossier partagé|shared folder|lecteur [a-z]:|disque réseau')],
    ciTypes: ['Server', 'Virtual Machine', 'NAS'],
    checks: {
      en: ['Is the server up (monitoring, ping) and are its services running?', 'Check disk space and the recent event log.', 'Shared folder: check the drive mapping and the NTFS / share permissions of the user.'],
      fr: ['Le serveur répond-il (supervision, ping) et ses services tournent-ils ?', "Vérifier l'espace disque et le journal d'événements récent.", "Dossier partagé : vérifier le mappage du lecteur et les droits NTFS / de partage de l'utilisateur."],
    },
  },
  {
    key: 'backup',
    label: { en: 'Backup / restore', fr: 'Sauvegarde / restauration' },
    patterns: [w('sauvegardes?|backups?|restaur\\w*|restore|récupérer|recuperer|recover|fichiers? supprimés?|deleted files?|corbeille|recycle bin|version précédente|previous version|perdu|lost')],
    checks: {
      en: ['Ask for the exact path, file name and the date it was last good.', 'Check the last successful backup and restore to a separate folder first.', 'Look at the previous versions / OneDrive recycle bin before the backup system.'],
      fr: ['Demander le chemin exact, le nom du fichier et la date à laquelle il était correct.', "Vérifier la dernière sauvegarde réussie et restaurer d'abord dans un dossier séparé.", 'Regarder les versions précédentes / la corbeille OneDrive avant le système de sauvegarde.'],
    },
  },
  {
    key: 'security',
    label: { en: 'Security (virus, phishing)', fr: 'Sécurité (virus, hameçonnage)' },
    patterns: [w('virus|malware|ransomware|rançongiciel|phishing|hameçonnage|hameconnage|arnaque|scam|suspect|suspicious|piraté|pirate|hacked|compromis|compromised|antivirus|chiffrés?|encrypted|lien bizarre|strange link|cliqué|clicked')],
    checks: {
      en: ['Treat as urgent: ask the user not to use the device and to disconnect it from the network if files look encrypted.', 'If a link was clicked or a password typed: reset the password, revoke sessions, check MFA and mailbox rules.', 'Run a full antivirus scan and check Action1 / the EDR for alerts.', 'Warn the other users if the phishing e-mail went to several people.'],
      fr: ["À traiter en urgence : demander de ne plus utiliser l'appareil et de le débrancher du réseau si des fichiers semblent chiffrés.", 'Si un lien a été cliqué ou un mot de passe saisi : réinitialiser le mot de passe, révoquer les sessions, vérifier la MFA et les règles de la boîte.', "Lancer une analyse antivirus complète et vérifier les alertes Action1 / de l'EDR.", "Prévenir les autres utilisateurs si l'e-mail d'hameçonnage a été envoyé à plusieurs personnes."],
    },
  },
  {
    key: 'software',
    label: { en: 'Software installation / update', fr: 'Installation / mise à jour de logiciel' },
    patterns: [w("install\\w*|logiciels?|software|applications?|appli|programme|mise à jour|mises à jour|update|upgrade|version|désinstaller|uninstall|adobe|acrobat|pdf|navigateur|browser|chrome|firefox|edge")],
    checks: {
      en: ['Check the licence and that the software is approved for the company.', 'Install remotely with Action1 when possible.', 'Note the version installed in the ticket.'],
      fr: ['Vérifier la licence et que le logiciel est autorisé pour la société.', 'Installer à distance avec Action1 si possible.', 'Noter la version installée dans le ticket.'],
    },
  },
  {
    key: 'access',
    label: { en: 'Access rights / permissions', fr: "Droits d'accès / permissions" },
    patterns: [w("accès|acces|access|droits?|permissions?|autoris\\w*|authoriz\\w*|refusé|denied|pas le droit|groupe|group")],
    checks: {
      en: ['Get the approval of the manager for any new access.', 'Add the user to the right group rather than giving direct rights.', 'Ask the user to sign out and in again after the change.'],
      fr: ['Obtenir l’accord du responsable pour tout nouvel accès.', "Ajouter l'utilisateur au bon groupe plutôt que de donner des droits directs.", "Demander à l'utilisateur de se déconnecter / reconnecter après la modification."],
    },
  },
  {
    key: 'phone',
    label: { en: 'Phone / mobile', fr: 'Téléphonie / mobile' },
    patterns: [w('téléphones?|telephones?|phones?|voip|standard|ipbx|pbx|smartphones?|mobiles?|iphone|android|ligne fixe|appel|calls?|softphone')],
    ciTypes: ['Mobile Device'],
    checks: {
      en: ['Desk phone or mobile? Does it have network / power?', 'Check the extension or the account on the phone system.', 'Mobile: check the company profile / MDM and the mail account.'],
      fr: ['Téléphone fixe ou mobile ? A-t-il le réseau / l’alimentation ?', 'Vérifier le poste ou le compte sur le standard.', 'Mobile : vérifier le profil entreprise / MDM et le compte de messagerie.'],
    },
  },
  {
    key: 'cctv',
    label: { en: 'Cameras / CCTV', fr: 'Caméras / vidéosurveillance' },
    patterns: [w('caméras?|cameras?|vidéosurveillance|videosurveillance|cctv|dvr|nvr|enregistreur|anpr|lpr|plaques?')],
    checks: {
      en: ['Which camera(s)? Live view, recording or remote access?', 'Check the recorder (NVR/DVR) disk and that the cameras are reachable on the network.'],
      fr: ['Quelle(s) caméra(s) ? Vue en direct, enregistrement ou accès à distance ?', "Vérifier le disque de l'enregistreur (NVR/DVR) et que les caméras répondent sur le réseau."],
    },
  },
  {
    key: 'onboarding',
    label: { en: 'New employee / departure', fr: 'Arrivée / départ de collaborateur' },
    patterns: [w("nouvel? (?:employé|collaborateur|salarié|arrivant|utilisateur)|new (?:user|employee|starter|hire)|arrivée|onboarding|départ|offboarding|quitte|leaving|stagiaire|intern")],
    checks: {
      en: ['Get the start (or end) date, job title, manager and the accesses needed.', 'Prepare the account, mailbox, licence, device and shared folders.', 'Departure: disable the account on the last day, convert the mailbox, collect the devices.'],
      fr: ["Obtenir la date d'arrivée (ou de départ), le poste, le responsable et les accès nécessaires.", 'Préparer le compte, la boîte mail, la licence, le matériel et les dossiers partagés.', 'Départ : désactiver le compte le dernier jour, convertir la boîte mail, récupérer le matériel.'],
    },
  },
  {
    key: 'purchase',
    label: { en: 'Purchase / quote', fr: 'Achat / devis' },
    patterns: [w("devis|quote|quotation|achat|acheter|purchase|buy|commande|commander|order|tarif|prix|price|budget")],
    checks: {
      en: ['Clarify quantity, specifications and the deadline.', 'Propose two options (price / quality) and check the stock with suppliers.'],
      fr: ['Préciser la quantité, les caractéristiques et le délai.', 'Proposer deux options (prix / qualité) et vérifier le stock chez les fournisseurs.'],
    },
  },
];

const URGENT = w("urgent|urgence|asap|au plus vite|immédiatement|immediately|bloquant|bloqué|bloque|blocked|impossible de travailler|can.?t work|cannot work|ne peut plus travailler|en panne|hors service|down|plus rien ne marche|nothing works|critique|critical");
const WIDE = w('tout le monde|tous les utilisateurs|toute l.?équipe|tous les postes|personne ne peut|everyone|all users|whole (?:team|office)|entire office|tout le bureau|toute la société|tous les services|plusieurs utilisateurs|several users');

const T: Record<Lang, Record<string, string>> = {
  en: {
    title: 'Automatic analysis (Taskora)',
    topic: 'What it is about',
    keywords: 'words found',
    requester: 'Requester',
    open: '{n} other open request(s)',
    repeat: '{n} request(s) about this in the last 30 days: consider a permanent fix.',
    device: 'Device',
    linked: 'linked to the ticket',
    mentioned: 'named in the message',
    theirs: 'assigned to the requester',
    a1: 'Action1: {critical} critical / {other} other missing updates{reboot}, last seen {seen}',
    reboot: ', restart pending',
    urgency: 'Urgency',
    urgent: 'the message sounds urgent ("{w}")',
    wide: 'several people seem affected ("{w}")',
    raise: 'consider raising the priority (now {p})',
    similar: 'Similar past tickets',
    checks: 'First checks',
    none: 'No clear topic found: read the request and add a category.',
  },
  fr: {
    title: 'Analyse automatique (Taskora)',
    topic: 'Sujet',
    keywords: 'mots trouvés',
    requester: 'Demandeur',
    open: '{n} autre(s) demande(s) ouverte(s)',
    repeat: '{n} demande(s) sur ce sujet ces 30 derniers jours : envisager une solution durable.',
    device: 'Appareil',
    linked: 'lié au ticket',
    mentioned: 'cité dans le message',
    theirs: 'attribué au demandeur',
    a1: 'Action1 : {critical} mises à jour critiques / {other} autres manquantes{reboot}, vu le {seen}',
    reboot: ', redémarrage en attente',
    urgency: 'Urgence',
    urgent: 'le message semble urgent (« {w} »)',
    wide: 'plusieurs personnes semblent touchées (« {w} »)',
    raise: 'envisager d’augmenter la priorité (actuellement {p})',
    similar: 'Tickets similaires',
    checks: 'Premières vérifications',
    none: 'Pas de sujet clair détecté : lire la demande et ajouter une catégorie.',
  },
};

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''));

export interface TopicMatch {
  key: string;
  label: string;
  words: string[];
  score: number;
  topic: Topic;
}

/** Topics of a text, best first (at most three). */
export function detectTopics(text: string, lang: Lang = 'en'): TopicMatch[] {
  const out: TopicMatch[] = [];
  for (const topic of TOPICS) {
    const words = new Set<string>();
    for (const re of topic.patterns) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      for (const m of text.matchAll(g)) words.add(m[0].replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase());
    }
    if (words.size) out.push({ key: topic.key, label: topic.label[lang], words: [...words].slice(0, 4), score: words.size, topic });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

const STOP = new Set(
  'pour avec dans sans plus mais tout tous toute fait faire avoir être sont nous vous elle ils mon mes notre votre leur cette ceci cela merci bonjour bonsoir svp please hello thanks thank with from that this have does dont cant will would could should there their about what when where which while sur une des les aux est pas que qui quoi'.split(' '),
);
const significant = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((x) => x.length >= 4 && !STOP.has(x)),
  );

/** Builds the analysis note and links a device named in the message. Returns null when nothing useful was found. */
export async function analyzeTicket(db: Db, ticketId: number) {
  const settings = await getSystemSettings(db);
  if (!settings.ticketInsightsEnabled) return { added: false };
  const lang: Lang = settings.language === 'fr' ? 'fr' : 'en';
  const t = T[lang];
  const [tk] = await db
    .select({
      id: s.tickets.id,
      title: s.tickets.title,
      description: s.tickets.description,
      companyId: s.tickets.companyId,
      contactId: s.tickets.contactId,
      configurationItemId: s.tickets.configurationItemId,
      tags: s.tickets.tags,
      createdAt: s.tickets.createdAt,
      priorityName: s.ticketPriorities.name,
      priorityLevel: s.ticketPriorities.level,
    })
    .from(s.tickets)
    .leftJoin(s.ticketPriorities, eq(s.ticketPriorities.id, s.tickets.priorityId))
    .where(eq(s.tickets.id, ticketId));
  if (!tk || tk.tags?.includes('recurring')) return { added: false };
  const [already] = await db.select({ id: s.ticketNotes.id }).from(s.ticketNotes).where(and(eq(s.ticketNotes.ticketId, ticketId), eq(s.ticketNotes.kind, 'insight'))).limit(1);
  if (already) return { added: false };

  const text = `${tk.title}\n${noteImagesToText(tk.description ?? '')}`.slice(0, 20000);
  const topics = detectTopics(text, lang);
  const lines: string[] = [];

  // Topics.
  if (topics.length) lines.push(`${t.topic}: ${topics.map((m) => `${m.label} (${t.keywords}: ${m.words.join(', ')})`).join(' · ')}`);
  else lines.push(t.none);

  // Requester: other open tickets and repeat requests on the same topic.
  if (tk.contactId) {
    const [c] = await db.select({ name: sql<string>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}` }).from(s.contacts).where(eq(s.contacts.id, tk.contactId));
    const recent = await db
      .select({ id: s.tickets.id, title: s.tickets.title, description: s.tickets.description, category: s.ticketStatuses.category, createdAt: s.tickets.createdAt })
      .from(s.tickets)
      .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
      .where(and(eq(s.tickets.contactId, tk.contactId), ne(s.tickets.id, tk.id), gte(s.tickets.createdAt, sql`now() - interval '90 days'`)))
      .limit(100);
    const open = recent.filter((r) => !['resolved', 'closed'].includes(r.category)).length;
    const parts = [`${t.requester}: ${c?.name ?? '—'}`];
    if (open) parts.push(fill(t.open, { n: open }));
    lines.push(parts.join(' — '));
    if (topics[0]) {
      const since = Date.now() - 30 * 86400_000;
      const same = recent.filter((r) => r.createdAt.getTime() > since && detectTopics(`${r.title}\n${r.description ?? ''}`, lang).some((m) => m.key === topics[0]!.key)).length;
      if (same >= 2) lines.push(fill(t.repeat, { n: same + 1 }));
    }
  }

  // Devices: named in the text, or the requester's own devices of the topic's kind.
  const devices = await db
    .select({
      id: s.configurationItems.id,
      name: s.configurationItems.name,
      hostname: s.configurationItems.hostname,
      serial: s.configurationItems.serialNumber,
      assetTag: s.configurationItems.assetTag,
      contactId: s.configurationItems.contactId,
      typeName: s.ciTypes.name,
    })
    .from(s.configurationItems)
    .innerJoin(s.ciTypes, eq(s.ciTypes.id, s.configurationItems.ciTypeId))
    .where(and(eq(s.configurationItems.companyId, tk.companyId), eq(s.configurationItems.lifecycleStatus, 'active')))
    .limit(2000);
  const lower = text.toLowerCase();
  const named = devices.filter((d) =>
    [d.name, d.hostname, d.serial, d.assetTag].some((v) => {
      const x = (v ?? '').trim().toLowerCase();
      return x.length >= 4 && new RegExp(`(?:^|[^a-z0-9])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`).test(lower);
    }),
  );
  const kinds = new Set(topics.flatMap((m) => m.topic.ciTypes ?? []));
  const theirs = named.length ? [] : devices.filter((d) => d.contactId && d.contactId === tk.contactId && (!kinds.size || kinds.has(d.typeName))).slice(0, 3);
  let linked: number | null = null;
  if (named.length === 1 && !tk.configurationItemId) {
    await updateTicket({ db, userId: null, automation: true }, tk.id, { configurationItemId: named[0]!.id });
    linked = named[0]!.id;
  }
  const shown = [...named.slice(0, 3).map((d) => ({ d, why: d.id === linked ? t.linked : t.mentioned })), ...theirs.map((d) => ({ d, why: t.theirs }))];
  if (shown.length) {
    const ids = shown.map((x) => x.d.id);
    const a1 = await db
      .select({
        ciId: s.action1Endpoints.configurationItemId,
        critical: s.action1Endpoints.missingCriticalUpdates,
        other: s.action1Endpoints.missingOtherUpdates,
        reboot: s.action1Endpoints.rebootRequired,
        seen: s.action1Endpoints.lastSeenAt,
      })
      .from(s.action1Endpoints)
      .where(and(inArray(s.action1Endpoints.configurationItemId, ids), isNull(s.action1Endpoints.missingSince)));
    for (const { d, why } of shown) {
      lines.push(`${t.device}: ${d.name} (${d.typeName}) — ${why}`);
      const e = a1.find((x) => x.ciId === d.id);
      if (e)
        lines.push(
          `   ${fill(t.a1, {
            critical: e.critical ?? 0,
            other: e.other ?? 0,
            reboot: e.reboot ? t.reboot : '',
            seen: e.seen ? e.seen.toISOString().slice(0, 10) : '—',
          })}`,
        );
    }
  }

  // Urgency and impact.
  const urgent = text.match(new RegExp(URGENT.source, 'iu'));
  const wide = text.match(new RegExp(WIDE.source, 'iu'));
  if (urgent || wide) {
    const parts: string[] = [];
    if (urgent) parts.push(fill(t.urgent, { w: urgent[0].replace(/^[^\p{L}]+/u, '') }));
    if (wide) parts.push(fill(t.wide, { w: wide[0].replace(/^[^\p{L}]+/u, '') }));
    if (tk.priorityLevel && tk.priorityLevel > 2) parts.push(fill(t.raise, { p: tk.priorityName ?? '' }));
    lines.push(`${t.urgency}: ${parts.join('; ')}`);
  }

  // Similar resolved tickets of the company, with their solution.
  const words = significant(tk.title);
  if (words.size) {
    const past = await db
      .select({ number: s.tickets.ticketNumber, title: s.tickets.title, resolution: s.tickets.resolution, resolvedAt: s.tickets.resolvedAt })
      .from(s.tickets)
      .where(and(eq(s.tickets.companyId, tk.companyId), ne(s.tickets.id, tk.id), sql`${s.tickets.resolvedAt} is not null`))
      .orderBy(desc(s.tickets.resolvedAt))
      .limit(300);
    const scored = past
      .map((p) => ({ p, score: [...significant(p.title)].filter((x) => words.has(x)).length }))
      .filter((x) => x.score >= Math.min(2, words.size))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (scored.length) {
      lines.push('', `${t.similar}:`);
      for (const { p } of scored) {
        const sol = noteImagesToText(p.resolution ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
        lines.push(`- ${p.number} "${p.title}"${p.resolvedAt ? ` (${p.resolvedAt.toISOString().slice(0, 10)})` : ''}${sol ? `: ${sol}` : ''}`);
      }
    }
  }

  // First checks for the main topic(s).
  const checks = [...new Set(topics.slice(0, 2).flatMap((m) => m.topic.checks[lang]))].slice(0, 6);
  if (checks.length) {
    lines.push('', `${t.checks}:`);
    for (const c of checks) lines.push(`- ${c}`);
  }

  await db.transaction((tx) => addTicketNote({ db: tx, userId: null, automation: true }, tk.id, { body: lines.join('\n'), visibility: 'internal', kind: 'insight' }));
  return { added: true, topics: topics.map((m) => m.key), linkedDeviceId: linked };
}
