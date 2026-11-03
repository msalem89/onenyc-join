<?php
// Copy to ../private/onenyc/config.php on the server (OUTSIDE public_html) and chmod 600.
// The path the endpoint looks for by default is <home>/private/onenyc/config.php.
return [
    // Absolute path to a writable directory outside the web root.
    'data_dir'     => '/home/YOUR_CPANEL_USER/private/onenyc/data',

    // Optional: when set, the endpoint rejects requests that send a different X-Intake-Token.
    // Leave empty to accept unsigned posts (the public sign-up form sends none).
    'intake_token' => '',
];
