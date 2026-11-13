// OneNYC compliance uploads.
//
// Target: the partner's own OneDrive folder, shared with the OneNYC admin.
// Reality today: onenyc.org is not a verified tenant domain (only onenyc.com is), so
// partners have no mailbox and therefore no OneDrive. The function therefore resolves
// the partner first and falls back to the site library under Intake/<code>/, marking the
// receipt pending_mailbox so the folder can be moved the day the mailbox exists.
//
// POST JSON { code, docId, name, type, data }  (data = base64, no data: prefix)
// Env: MSGRAPH_ONENYC_{CLIENT_ID,CLIENT_SECRET,TENANT_ID}, SHAREPOINT_SITE,
//      SHAREPOINT_ADMIN (UPN to share with), SHAREPOINT_UPLOAD_FOLDER

import crypto from 'node:crypto';

const ALLOW = ['https://join.onenyc.org', 'https://onenyc.org', 'https://www.onenyc.org'];
const TENANT = process.env.MSGRAPH_ONENYC_TENANT_ID || process.env.MSGRAPH_TENANT_ID_ONENYC;
const CLIENT = process.env.MSGRAPH_ONENYC_CLIENT_ID || process.env.MSGRAPH_CLIENT_ID_ONENYC;
const SECRET = process.env.MSGRAPH_ONENYC_CLIENT_SECRET || process.env.MSGRAPH_ONENYC_SECRET;
const SITE = process.env.SHAREPOINT_SITE || 'netorg19167036.sharepoint.com:/sites/onenycworkinggroup';
const ADMIN = process.env.SHAREPOINT_ADMIN || 'mohamed@onenyc.com';
const FOLDER = process.env.SHAREPOINT_UPLOAD_FOLDER || 'Intake';
const MAX_BYTES = 3.5 * 1024 * 1024;

// Same labels the desk uses on the page; keep the order stable so names sort sensibly.
const DOC_LABEL = {
  doc_501c3: 'IRS 501(c)(3) Determination Letter',
  doc_incorporation: 'NYS Certificate of Incorporation',
  doc_ein: 'IRS EIN Letter',
  doc_charities: 'NYS Charities Registration',
  doc_bylaws: 'Organizational By-Laws',
  doc_board_roster: 'Board of Directors Roster',
  doc_coi_policy: 'Conflict of Interest Policy',
  doc_board_resolution: 'Board Authorization Resolution',
  doc_form990: 'Form 990',
  doc_operating_budget: 'Annual Operating Budget',
  doc_program_budget: 'Program Budget',
  doc_insurance_coi: 'Certificate of Liability Insurance',
  doc_workers_comp: 'Workers Compensation Proof',
};

const CODE_RE = /^ONENYC-\d{4}-[A-Z0-9]{4,10}$/;

function cors(origin) {
  const allow = ALLOW.includes(origin) ? origin : ALLOW[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function tidy(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120);
}

let cache = { token: null, exp: 0 };
async function token() {
  if (cache.token && Date.now() < cache.exp - 60_000) return cache.token;
  const body = new URLSearchParams({
    client_id: CLIENT, client_secret: SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const j = await res.json();
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cache.token;
}

async function graph(tok, path, init = {}) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tok}`, ...(init.headers || {}) },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

// code → { org, email } from the blob queue. Small tenant, so scan the manifest
// instead of indexing; a handful of records at current volume.
async function lookupCode(tok, code) {
  const blobMod = await import('@vercel/blob');
  const { get } = blobMod;
  const readBlobPath = async (pathname) => {
    try {
      const r = await get(pathname, { access: 'private' });
      if (!r || r.statusCode !== 200) return null;
      return JSON.parse(await new Response(r.stream).text());
    } catch { return null; }
  };

  const manifest = await readBlobPath('signups/_manifest.json');
  const entries = (manifest && Array.isArray(manifest.signups)) ? manifest.signups : [];
  for (const e of entries) {
    const rec = await readBlobPath(`signups/${e.pid}.json`);
    if (rec && String(rec.confirmation_code || '').toUpperCase() === code) {
      return {
        org: rec.organization?.legal_name || e.org || '',
        email: rec.signer?.email || '',
        pid: e.pid || '',
      };
    }
  }
  return null;
}

async function siteDrive(tok) {
  const site = await graph(tok, `/sites/${SITE}`);
  if (!site.ok) throw new Error(`site ${site.status}`);
  const dr = await graph(tok, `/sites/${site.body.id}/drive`);
  if (!dr.ok) throw new Error(`drive ${dr.status}`);
  return dr.body.id;
}

async function partnerUser(tok, email) {
  if (!email) return null;
  const q = await graph(tok, `/users?$select=id,mail,userPrincipalName&$filter=mail eq '${email.replace(/'/g, "''")}'`);
  if (q.ok && q.body.value?.length) return q.body.value[0];
  return null;
}

async function ensureShared(tok, driveId, folderPath, user) {
  // Give the admin edit on the partner folder. Idempotent enough: an existing
  // permission for the same recipient just returns another grant.
  await graph(tok, `/drives/${driveId}/root:/${encodeURI(folderPath)}:/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipients: [{ email: ADMIN }],
      message: 'OneNYC compliance documents for this application.',
      requireSignIn: true,
      sendInvitation: false,
      roles: ['write'],
    }),
  }).catch(() => {});
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  for (const [k, v] of Object.entries(cors(origin))) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, detail: 'POST only' });
  if (!TENANT || !CLIENT || !SECRET) {
    return res.status(503).json({ ok: false, detail: 'upload is not configured on this deployment' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, detail: 'bad json' }); }
  }
  body = body || {};

  const code = String(body.code || '').toUpperCase().trim();
  const emailIn = String(body.email || '').trim().toLowerCase();
  const docId = String(body.docId || '').slice(0, 60);
  const type = String(body.type || 'application/octet-stream').slice(0, 120);
  if (!CODE_RE.test(code)) return res.status(422).json({ ok: false, detail: 'a valid application code is required' });
  if (!body.data || typeof body.data !== 'string') return res.status(422).json({ ok: false, detail: 'no file data' });

  let bytes;
  try { bytes = Buffer.from(body.data, 'base64'); } catch { return res.status(400).json({ ok: false, detail: 'bad base64' }); }
  if (!bytes.length) return res.status(422).json({ ok: false, detail: 'empty file' });
  if (bytes.length > MAX_BYTES) {
    return res.status(413).json({ ok: false, detail: 'file too large' });
  }

  const rawExt = String(body.name || '').match(/\.[A-Za-z0-9]{1,5}$/)?.[0]?.toLowerCase() || '.pdf';
  const label = DOC_LABEL[docId] || tidy(String(body.name || '').replace(/\.[^.]+$/, '')) || 'Supporting Document';

  try {
    const tok = await token();
    const who = await lookupCode(tok, code).catch(() => null);

    // A code alone is not identity: it travels in a URL. Require the signer's own
    // address as well, and answer the same way whether the code is unknown or the
    // email does not match, so this cannot be used to test codes.
    const owner = String(who?.email || '').trim().toLowerCase();
    if (!who || !owner) {
      console.warn('upload refused: unknown code', { code: code.slice(0, 12) });
      return res.status(403).json({ ok: false, detail: 'this application could not be verified' });
    }
    if (!emailIn || emailIn !== owner) {
      console.warn('upload refused: code/email mismatch', { code: code.slice(0, 12), hasEmail: !!emailIn });
      return res.status(403).json({ ok: false, detail: 'this application could not be verified' });
    }
    const entity = tidy(who?.org || 'Applicant');
    const person = await partnerUser(tok, who?.email).catch(() => null);

    const fileName = `${entity}.${label}${rawExt}`;

    let driveId;
    let folderPath;
    let sharedWithAdmin = false;

    if (person && person.id) {
      const dr = await graph(tok, `/users/${person.id}/drive`);
      if (dr.ok) {
        driveId = dr.body.id;
        folderPath = `OneNYC Intake/${code}`;
        await ensureShared(tok, driveId, folderPath, person);
        sharedWithAdmin = true;
      }
    }
    if (!driveId) {
      driveId = await siteDrive(tok);
      folderPath = `${FOLDER}/${code}`;
    }

    const put = await graph(tok, `/drives/${driveId}/root:/${encodeURI(`${folderPath}/${fileName}`)}:/content`, {
      method: 'PUT',
      headers: { 'Content-Type': type },
      body: bytes,
    });
    if (!put.ok) {
      console.error('sharepoint put failed', { status: put.status, code: put.body?.error?.code });
      return res.status(502).json({ ok: false, detail: 'the file could not be stored' });
    }

    // Prove the bytes landed, rather than trusting the upload response: re-read the
    // item metadata, and only report success if SharePoint holds the same length.
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const back = await graph(tok, `/drives/${driveId}/items/${put.body.id}?$select=id,name,size,webUrl,file,lastModifiedDateTime`);
    const stored = back.ok && back.body && typeof back.body.size === 'number';
    const verified = stored && back.body.size === bytes.length;

    // A receipt inside the partner's own folder: survives a closed tab, a crashed
    // browser, and any doubt about what was received.
    const receiptPath = `${folderPath}/_received.json`;
    let receipt = {};
    const prior = await graph(tok, `/drives/${driveId}/root:/${encodeURI(receiptPath)}:/content`);
    if (prior.ok && prior.body && typeof prior.body === 'object') receipt = prior.body;
    receipt[docId || put.body.name] = {
      name: back.body?.name || put.body.name,
      size: bytes.length,
      sha256,
      verified,
      item_id: put.body.id,
      at: new Date().toISOString(),
      name_as_sent: String(body.name || ''),
    };
    await graph(tok, `/drives/${driveId}/root:/${encodeURI(receiptPath)}:/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(receipt, null, 2), 'utf-8'),
    }).catch(() => {});

    if (!verified) {
      console.error('upload verification failed', { expected: bytes.length, stored: back.body?.size });
      return res.status(502).json({ ok: false, detail: 'the file could not be stored' });
    }

    return res.status(200).json({
      ok: true,
      code,
      docId,
      name: back.body.name,
      size: bytes.length,
      sha256,
      verified: true,
      receipt: receiptPath,
      path: folderPath,
      store: sharedWithAdmin ? 'partner-onedrive' : 'site-library',
      shared_with: sharedWithAdmin ? ADMIN : null,
      pending_mailbox: !sharedWithAdmin,
      webUrl: back.body.webUrl || put.body.webUrl || null,
    });
  } catch (err) {
    console.error('upload failed', err?.message || err);
    return res.status(502).json({ ok: false, detail: 'the file could not be stored' });
  }
}
