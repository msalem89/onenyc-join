// OneNYC Impact Partners intake — serverless signup receiver (v3: Node req/res).
// Contract-compatible with intake_server.py /signup and signup.php.
// Storage: Vercel Blob — NAFS Mac pulls via ip_pull_vercel.sh (launchd:300s,
// wake-safe, idempotent dedup downstream).

const EIN_RE = /^\d{2}-\d{7}$/;

// org mailbox local-part (port of org_mailbox.slug_local — keep in sync)
const STOP_ARTICLES = new Set(['the','a','an','and','or','of','for','in','on','at','to','by','&']);
const LEGAL_SUFFIXES = new Set(['inc','inc.','llc','ltd','corp','co','co.','corporation']);
function slugLocal(org) {
  const cleaned = String(org || '').replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
  const raw = cleaned.split(/\s+/).filter(Boolean);
  if (!raw.length) return 'partner';
  const meaningful = raw.filter(w => !STOP_ARTICLES.has(w.toLowerCase()) && !LEGAL_SUFFIXES.has(w.toLowerCase()));
  const words = meaningful.length ? meaningful : raw;
  if (words.length >= 3) {
    const acr = words.map(w => w[0]).join('').toLowerCase();
    if (acr.length >= 2 && acr.length <= 10) return acr;
  }
  return words[0].toLowerCase();
}
const MAIL_DOMAIN = 'onenyc.org';

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allow = ['https://join.onenyc.org', 'https://onenyc.org', 'https://www.onenyc.org'].includes(origin)
    ? origin : 'https://join.onenyc.org';
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Intake-Token');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ detail: 'POST only.' });

  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
    const org = String(body.org || body.legal_name || body.organization_name || '').trim();
    const signer = String(body.signer_name || [body.first_name, body.last_name].filter(Boolean).join(' ') || '').trim();
    const email = String(body.signer_email || body.email || '').trim();
    const ack = !!(body.legal_advisory_ack ?? body.terms_accepted ?? body.tos_accepted);
    const ein = String(body.ein || '').trim();

    if (org.length < 2) return res.status(422).json({ detail: 'organization name required' });
    if (!signer) return res.status(422).json({ detail: 'signer name required' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(422).json({ detail: 'valid signer email required' });
    if (!ack) return res.status(422).json({ detail: 'legal_advisory_ack must be accepted' });
    if (ein && !EIN_RE.test(ein)) return res.status(422).json({ detail: 'ein must match ##-####### (or be omitted)' });

    const pid = 'PARTNER-' + fnv(`${org}|${email}`.toLowerCase()).toString(16).toUpperCase().padStart(8, '0').slice(-8);
    const code = 'ONENYC-2026-' + fnv(pid).toString(36).toUpperCase().slice(0, 6);

    const record = {
      partner_id: pid,
      confirmation_code: code,
      submitted_at: new Date().toISOString(),
      organization: {
        legal_name: org,
        ein,
        borough: String(body.borough || '').trim(),
        council_district: String(body.council_district || '').trim(),
      },
      signer: { name: signer, email, phone: String(body.phone || '').trim() },
      legal_advisory_ack: true,
      terms_accepted: true,
      tos_accepted: true,
      terms_version: 'v1-2026-11',
      source: 'vercel-intake',
    };

    // org mailbox reservation (owner directive 2026-11-04): <company>@onenyc.org.
    // Graph creds stay server-side; until the domain is verified in the M365
    // tenant the address is RESERVED only (pending_domain), never created.
    const local = slugLocal(org);
    const orgEmail = `${local}@${MAIL_DOMAIN}`;
    let orgEmailStatus = 'reserved_pending_domain';
    let orgEmailNote = 'onenyc.org is not yet verified in the M365 tenant; your address is reserved and activates automatically once the domain is added.';
    try {
      const GRAPH = 'https://graph.microsoft.com/v1.0';
      const tok = process.env.ORG_MAIL_GRAPH_TOKEN
        || process.env.GRAPH_TOKEN_ONENYC;
      if (tok) {
        const dr = await fetch(`${GRAPH}/domains/${MAIL_DOMAIN}`, {
          headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(8000),
        });
        if (dr.ok) {
          const d = await dr.json();
          if (d.isVerified) {
            // domain live: create orgContact routing to the signer inbox (contact mode)
            const cr = await fetch(`${GRAPH}/contacts`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                displayName: org,
                mail: orgEmail,
                mailNickname: local,
                emailAddresses: [{ address: orgEmail, name: org }],
              }),
              signal: AbortSignal.timeout(15000),
            });
            if (cr.ok) { orgEmailStatus = 'created'; orgEmailNote = `Mailbox ${orgEmail} now routes to ${email}.`; }
            else if (cr.status === 409) { orgEmailStatus = 'already_exists'; orgEmailNote = `Mailbox ${orgEmail} already exists.`; }
            else { orgEmailStatus = `error_http_${cr.status}`; orgEmailNote = 'Mailbox creation failed; address stays reserved.'; }
          }
        }
      }
    } catch {}
    record.org_email = { email: orgEmail, status: orgEmailStatus };

    // @vercel/blob 1.x has no get(); head() then fetch is the read path. The store is
    // private, so that fetch must carry the read-write token — an anonymous GET now
    // fails, which is the point.
    const { put, get } = await import('@vercel/blob');
    const readBlob = async (pathname) => {
      try {
        const r = await get(pathname, { access: 'private' });
        if (!r || r.statusCode !== 200) return null;
        return JSON.parse(await new Response(r.stream).text());
      } catch { return null; }
    };
    // v3.1 (2026-11-09): a repeat submission is acknowledged, never re-registered.
    // The Mac pull (ip_pull_signups.py) dedupes on EIN then signer email and sends
    // no second welcome email, so without this the page promised a message that
    // could never arrive. The existing record is left exactly as it was.
    const prior = await readBlob(`signups/${pid}.json`);
    if (prior) {
      return res.status(200).json({
        status: 'exists',
        confirmation_code: code,
        partner_id: pid,
        first_submitted_at: prior.submitted_at || prior.timestamp || null,
        welcome_email: 'not_resent',
        org_email: (prior.org_email && prior.org_email.email) || orgEmail,
        org_email_status: (prior.org_email && prior.org_email.status) || 'reserved_pending_domain',
        org_email_note: 'Address already on file; nothing was created or changed.',
        message: `Application already on file \u2014 reference ${code}. Nothing new was created and no new welcome email was sent; the message sent earlier still stands. Write to info@onenyc.com if you need it again.`,
      });
    }
    const stored = await put(`signups/${pid}.json`, JSON.stringify(record, null, 2), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
    const recordUrl = (stored && stored.url) || null;
    // manifest append (idempotent by pid) so the Mac pull needs no admin API.
    // If the manifest is missing or unreadable, rebuild it from the records rather
    // than starting empty — the earlier bug overwrote it on every signup, which left
    // 41 records invisible to code lookup while the files were still there.
    let manifest = await readBlob('signups/_manifest.json');
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.signups)) {
      manifest = { signups: [] };
      try {
        const { list } = await import('@vercel/blob');
        const all = await list({ prefix: 'signups/PARTNER-' });
        for (const b of all.blobs || []) {
          const rec = await readBlob(b.pathname);
          if (rec && rec.partner_id) {
            manifest.signups.push({ pid: rec.partner_id, org: rec.organization?.legal_name || '', url: '', ts: rec.submitted_at });
          }
        }
        console.warn('manifest rebuilt from records', { entries: manifest.signups.length });
      } catch (e) { console.error('manifest rebuild failed', e?.message); }
    }
    if (!Array.isArray(manifest.signups)) manifest.signups = [];
    if (!manifest.signups.find((e) => e.pid === pid)) {
      manifest.signups.push({ pid, org, url: recordUrl, ts: record.submitted_at });
      manifest.updated = record.submitted_at;
      await put('signups/_manifest.json', JSON.stringify(manifest), {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
      });
    }

    return res.status(200).json({
      status: 'success',
      confirmation_code: code,
      partner_id: pid,
      timestamp: record.submitted_at,
      passport_status: ein ? 'queued' : 'data_pending',
      org_email: orgEmail,
      org_email_status: orgEmailStatus,
      org_email_note: orgEmailNote,
      message: `Partner registered. Your address ${orgEmail} is reserved${orgEmailStatus === 'created' ? ' and active' : ' and activates once the onenyc.org domain is verified'}; Impact Partner Agreement next steps arrive by email.`,
    });
  } catch (err) {
    return res.status(503).json({
      detail: 'intake storage unavailable; please retry',
      debug: String(err && err.message).slice(0, 200),
    });
  }
}
