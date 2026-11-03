<?php
/**
 * OneNYC Partners sign-up endpoint — cPanel/PHP twin of POST /signup on intake_server.py.
 *
 * Contract (must stay byte-compatible with the Python API):
 *   in : JSON {org|legal_name, signer_name, signer_email|email, ein?, borough?, council_district?,
 *              passport_status?, legal_advisory_ack}
 *   out: {status, confirmation_code, partner_id, timestamp, passport_status,
 *         passport_packet_id, passport_job_id, message}
 *
 * Design notes:
 * - The owner's sign-up is four fields plus a terms checkbox, so an EIN is optional; without one the
 *   record is still accepted and reports passport_status "data_pending" (a PASSPort packet cannot be
 *   staged without it). A malformed EIN is rejected.
 * - Data lives OUTSIDE public_html ($ONENYC_DATA_DIR), one JSON file per partner plus an append-only
 *   JSONL ledger. Nothing here logs names, emails or EINs.
 * - Config is a PHP file outside the web root; missing config fails closed (503) rather than
 *   silently accepting sign-ups into nowhere.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

const ALLOWED_ORIGINS = [
    'https://join.onenyc.org',
    'https://onenyc.org',
    'https://www.onenyc.org',
];

function respond(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && in_array($origin, ALLOWED_ORIGINS, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Intake-Token');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(405, ['detail' => 'POST only.']);
}

/* ---- config (outside web root) ------------------------------------------------ */
$configPath = getenv('ONENYC_CONFIG') ?: dirname(__DIR__, 2) . '/private/onenyc/config.php';
if (!is_readable($configPath)) {
    error_log('onenyc_signup: config missing at ' . $configPath);
    respond(503, ['detail' => 'Sign-up is temporarily unavailable.']);
}
$CFG = require $configPath;
$dataDir = rtrim((string)($CFG['data_dir'] ?? ''), '/');
if ($dataDir === '' || !is_dir($dataDir) || !is_writable($dataDir)) {
    error_log('onenyc_signup: data_dir unusable');
    respond(503, ['detail' => 'Sign-up storage is not writable.']);
}

/* ---- optional shared token ---------------------------------------------------- */
$token = (string)($CFG['intake_token'] ?? '');
$sent  = trim((string)($_SERVER['HTTP_X_INTAKE_TOKEN'] ?? ''));
if ($token !== '' && $sent !== '' && !hash_equals($token, $sent)) {
    respond(401, ['detail' => 'Invalid intake token.']);
}

/* ---- rate limit: 5 posts / 10 min / IP --------------------------------------- */
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$bucket = sys_get_temp_dir() . '/onenyc_rl_' . hash('sha256', $ip);
$now = time();
$hits = [];
if (is_readable($bucket)) {
    $raw = json_decode((string)file_get_contents($bucket), true);
    if (is_array($raw)) {
        $hits = array_values(array_filter($raw, static fn($t) => is_int($t) && $t > $now - 600));
    }
}
if (count($hits) >= 5) {
    respond(429, ['detail' => 'Too many sign-up attempts; please wait a moment.']);
}
$hits[] = $now;
@file_put_contents($bucket, json_encode($hits), LOCK_EX);

/* ---- body -------------------------------------------------------------------- */
$raw = file_get_contents('php://input') ?: '';
if (strlen($raw) > 262144) {
    respond(413, ['detail' => 'Payload too large.']);
}
$body = json_decode($raw, true);
if (!is_array($body)) {
    respond(400, ['detail' => 'Invalid JSON body']);
}

$clean = static fn($v): string => is_string($v) ? trim($v) : '';
$org     = $clean($body['org'] ?? $body['legal_name'] ?? '');
$signer  = $clean($body['signer_name'] ?? '');
$email   = $clean($body['signer_email'] ?? $body['email'] ?? '');
$einRaw  = $clean($body['ein'] ?? '');
$ack     = (bool)($body['legal_advisory_ack'] ?? false);
$tos     = (bool)($body['tos_accepted'] ?? false);
$termsV  = $clean($body['terms_version'] ?? '');
$tosAt   = $clean($body['tos_accepted_at'] ?? '');

if ($org === '')            respond(400, ['detail' => 'Organization legal name is required.']);
if ($signer === '')         respond(400, ['detail' => 'Signer name is required.']);
if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    respond(400, ['detail' => 'A valid contact email is required.']);
}
if (!$ack)                  respond(400, ['detail' => 'Legal advisory acknowledgment must be accepted.']);
if (!$tos)                  respond(400, ['detail' => 'Terms of Service and Privacy Notice must be accepted.']);

$ein = preg_replace('/[^0-9]/', '', $einRaw) ?? '';
if ($ein !== '' && strlen($ein) !== 9) {
    respond(400, ['detail' => 'EIN must be a valid 9-digit federal EIN (format XX-XXXXXXX) or left blank.']);
}
$einMissing = ($ein === '');
$einPretty  = $einMissing ? '' : substr($ein, 0, 2) . '-' . substr($ein, 2);

$partnerId  = 'PARTNER-' . strtoupper(bin2hex(random_bytes(4)));
$confirm    = 'ONENYC-2026-' . strtoupper(bin2hex(random_bytes(3)));
$nowIso     = gmdate('c');
$passportIn = $clean($body['passport_status'] ?? 'No Account');
$needsPacket = !$einMissing && stripos($passportIn, 'active') === false
    && stripos($passportIn, 'verified') === false && stripos($passportIn, 'approved') === false;
$passportStatus = $einMissing ? 'data_pending' : ($needsPacket ? 'queued_for_enrollment' : 'active');

/* ---- record ------------------------------------------------------------------ */
$record = [
    'confirmation_code' => $confirm,
    'partner_id'        => $partnerId,
    'submitted_at'      => $nowIso,
    'source'            => 'join.onenyc.org (cPanel)',
    'organization'      => [
        'legal_name'       => $org,
        'ein'              => $einPretty,
        'council_district' => $clean($body['council_district'] ?? ''),
        'borough'          => $clean($body['borough'] ?? ''),
        'address'          => $clean($body['address'] ?? ''),
    ],
    'signer' => ['name' => $signer, 'email' => $email, 'phone' => $clean($body['phone'] ?? '')],
    'compliance' => [
        'passport_status'    => $passportStatus,
        'legal_advisory_ack' => $ack,
        'tos_accepted'       => $tos,
        'terms_version'      => $termsV,
        'terms_accepted_at'  => $tosAt !== '' ? $tosAt : $nowIso,
        'ein_missing'        => $einMissing,
    ],
    'capacity_survey' => [
        'community_reach'   => $clean($body['reach'] ?? ''),
        'program_title'     => $clean($body['prog_title'] ?? ''),
        'program_narrative' => $clean($body['prog_narrative'] ?? ''),
        'annual_budget'     => $body['annual_budget'] ?? null,
    ],
];

$file = $dataDir . '/' . $partnerId . '.json';
$okA  = @file_put_contents($file, json_encode($record, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX) !== false;
$okB  = @file_put_contents(
    $dataDir . '/signups.jsonl',
    json_encode(['partner_id' => $partnerId, 'confirmation_code' => $confirm, 'submitted_at' => $nowIso,
                 'org' => $org, 'email' => $email, 'passport_status' => $passportStatus,
                 'ein_missing' => $einMissing], JSON_UNESCAPED_SLASHES) . PHP_EOL,
    FILE_APPEND | LOCK_EX
) !== false;

if (!$okA || !$okB) {
    error_log('onenyc_signup: write failed for ' . $partnerId);
    respond(500, ['detail' => 'Could not record the sign-up.']);
}

error_log('onenyc_signup: recorded ' . $partnerId . ' status=' . $passportStatus);

respond(200, [
    'status'            => 'success',
    'confirmation_code' => $confirm,
    'partner_id'        => $partnerId,
    'timestamp'         => $nowIso,
    'passport_status'   => $passportStatus,
    'passport_packet_id' => null,
    'passport_job_id'   => null,
    'message'           => $einMissing
        ? 'Partner organization onboarded successfully. Add an EIN to compile the PASSPort packet.'
        : 'Partner organization onboarded successfully. Municipal readiness dossier recorded.',
]);
