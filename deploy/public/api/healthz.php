<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
$cfg = getenv('ONENYC_CONFIG') ?: dirname(__DIR__, 2) . '/private/onenyc/config.php';
$ok  = is_readable($cfg);
http_response_code($ok ? 200 : 503);
echo json_encode(['status' => $ok ? 'ok' : 'degraded', 'service' => 'onenyc-signup', 'time' => gmdate('c')]);
