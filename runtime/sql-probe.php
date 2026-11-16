<?php
/** Read-only PDO probes. Secrets enter on stdin; only typed diagnostic facts leave stdout. */

/** Classify a driver error without returning its message, DSN, bindings or credentials. */
function classifyDriverError(Throwable $exception): array
{
    $message = strtolower($exception->getMessage());
    $native = $exception instanceof PDOException ? (int) ($exception->errorInfo[1] ?? 0) : 0;
    if (preg_match('/ee certificate key too weak|legacy sigalg|no suitable signature algorithm|unsupported protocol|tlsv1 alert protocol version|dh key too small/', $message)) {
        return ['category' => 'tls', 'reason' => 'legacyTls'];
    }
    if (preg_match('/certificate verify failed|self.signed|certificate chain|certificate.*not trusted|unable to get local issuer|hostname.*mismatch|target principal name is incorrect/', $message)) {
        return ['category' => 'tls', 'reason' => 'certificate'];
    }
    if (preg_match('/ssl provider|tls handshake|pre.login handshake/', $message)) {
        return ['category' => 'tls', 'reason' => 'tlsHandshake'];
    }
    if (in_array($native, [4060, 916, 229, 230, 262, 297, 300], true) || preg_match('/cannot open database|permission.*denied|not able to access.*database/', $message)) {
        return ['category' => 'permissions', 'reason' => 'databaseAccess'];
    }
    if ($native === 18456 || str_contains($message, '18456') || str_contains($message, 'login failed')) {
        return ['category' => 'authentication', 'reason' => 'loginRejected'];
    }
    if (preg_match('/getaddrinfo|name or service not known|no such host|could not resolve/', $message)) {
        return ['category' => 'network', 'reason' => 'dns'];
    }
    if (preg_match('/timeout|timed out|refused|network.related|server.*not found|tcp provider|10061|10060/', $message)) {
        return ['category' => 'network', 'reason' => 'tcpFailed'];
    }
    return ['category' => 'unknown', 'reason' => 'unclassified'];
}

/** Return a consistent, credential-free step consumed by the bilingual UI. */
function diagnosticStep(string $id, string $status, string $category, string $reason, array $evidence = []): array
{
    return compact('id', 'status', 'category', 'reason', 'evidence') + ['action' => $reason];
}

/** Reject DSN injection even when a diagnostic is fed from an edited environment file. */
function validateConnection(array $connection): void
{
    if (!preg_match('/\A[A-Za-z0-9_.:\-]+\z/', (string) ($connection['host'] ?? ''))
        || !preg_match('/\A[A-Za-z][A-Za-z0-9_]{0,127}\z/', (string) ($connection['database'] ?? ''))
        || (int) ($connection['port'] ?? 0) < 1 || (int) ($connection['port'] ?? 0) > 65535) {
        throw new InvalidArgumentException('Invalid diagnostic target.');
    }
}

/** Test DNS/TCP before opening a SQL session. A successful socket is not a SQL login. */
function probeTcp(array $connection): array
{
    $host = $connection['host'];
    if (str_contains($host, ':')) {
        $host = '['.$host.']';
    }
    $socket = @stream_socket_client('tcp://'.$host.':'.$connection['port'], $errorCode, $errorMessage, 3);
    if ($socket !== false) {
        fclose($socket);
        return diagnosticStep($connection['id'].'.tcp', 'passed', 'network', 'tcpPassed', ['host' => $connection['host'], 'port' => $connection['port']]);
    }
    $reason = preg_match('/getaddrinfo|name or service|resolve/', strtolower($errorMessage)) ? 'dns' : 'tcpFailed';
    return diagnosticStep($connection['id'].'.tcp', 'failed', 'network', $reason, ['host' => $connection['host'], 'port' => $connection['port']]);
}

/** Connect using precisely the application's TLS options and bound PDO credentials. */
function connectSql(array $connection): PDO
{
    $host = $connection['host'];
    if (str_contains($host, ':')) {
        $host = '['.$host.']';
    }
    $dsn = 'sqlsrv:Server='.$host.','.$connection['port'].';Database='.$connection['database']
        .';Encrypt='.($connection['encrypt'] ? 'yes' : 'no')
        .';TrustServerCertificate='.($connection['trust'] ? 'yes' : 'no').';LoginTimeout=5';
    $pdo = new PDO($dsn, $connection['username'], $connection['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->setAttribute(PDO::SQLSRV_ATTR_QUERY_TIMEOUT, 5);
    return $pdo;
}

/** Read only public version/effective auth mode, own-login state and own database privileges. */
function readConnectionFacts(PDO $pdo, array $connection): array
{
    $steps = [];
    $id = $connection['id'];
    $facts = $pdo->query("SELECT CONVERT(varchar(64),SERVERPROPERTY('ProductVersion')) AS version, CONVERT(int,SERVERPROPERTY('IsIntegratedSecurityOnly')) AS windowsOnly, IS_SRVROLEMEMBER('sysadmin') AS sysadmin, IS_MEMBER('db_owner') AS dbOwner, HAS_PERMS_BY_NAME(NULL,NULL,'CONNECT SQL') AS connectSql, HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONNECT') AS databaseConnect, HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CREATE TABLE') AS createTable")->fetch(PDO::FETCH_ASSOC);
    $steps[] = diagnosticStep($id.'.effectiveMode', (int) $facts['windowsOnly'] === 1 ? 'failed' : 'passed', 'authentication', (int) $facts['windowsOnly'] === 1 ? 'windowsOnly' : 'mixedEffective', ['windowsOnly' => (int) $facts['windowsOnly']]);
    $steps[] = diagnosticStep($id.'.version', (int) explode('.', $facts['version'])[0] < 11 ? 'warning' : 'passed', 'tls', (int) explode('.', $facts['version'])[0] < 11 ? 'legacySql' : 'versionFound', ['version' => $facts['version']]);
    $ownLogin = $pdo->query('SELECT is_disabled FROM sys.server_principals WHERE name = ORIGINAL_LOGIN()')->fetchColumn();
    $steps[] = diagnosticStep($id.'.login', $ownLogin === false ? 'notChecked' : ((int) $ownLogin === 0 && (int) $facts['connectSql'] === 1 ? 'passed' : 'failed'), 'authentication', $ownLogin === false ? 'metadataUnknown' : ((int) $ownLogin === 0 && (int) $facts['connectSql'] === 1 ? 'loginEnabled' : 'loginDisabled'), ['enabled' => $ownLogin === false ? null : (int) $ownLogin === 0, 'connectSql' => (int) $facts['connectSql']]);
    if ($connection['role'] === 'runtime') {
        $unsafe = (int) $facts['sysadmin'] === 1 || (int) $facts['dbOwner'] === 1;
        $access = (int) $facts['databaseConnect'] === 1;
        $steps[] = diagnosticStep($id.'.permissions', !$access || $unsafe ? 'failed' : 'passed', 'permissions', $unsafe ? 'runtimePrivileged' : ($access ? 'runtimeAccess' : 'databaseAccess'), ['database' => $connection['database'], 'sysadmin' => (int) $facts['sysadmin'], 'dbOwner' => (int) $facts['dbOwner'], 'createTable' => (int) $facts['createTable']]);
    } else {
        $steps[] = diagnosticStep($id.'.bootstrapRights', (int) $facts['sysadmin'] === 1 ? 'passed' : 'warning', 'permissions', (int) $facts['sysadmin'] === 1 ? 'bootstrapRights' : 'bootstrapRightsUnknown', ['sysadmin' => (int) $facts['sysadmin']]);
        foreach ($connection['databases'] ?? [] as $database) {
            if (!preg_match('/\A[A-Za-z][A-Za-z0-9_]{0,127}\z/', $database)) {
                continue;
            }
            $statement = $pdo->prepare('SELECT DB_ID(?) AS databaseId, HAS_DBACCESS(?) AS hasAccess');
            $statement->execute([$database, $database]);
            $result = $statement->fetch(PDO::FETCH_ASSOC);
            $missing = $result['databaseId'] === null;
            $authoritative = (int) $facts['sysadmin'] === 1;
            $steps[] = diagnosticStep($id.'.database.'.$database, $missing ? ($authoritative ? ($connection['type'] === 'application' ? 'warning' : 'failed') : 'notChecked') : ((int) $result['hasAccess'] === 1 ? 'passed' : 'failed'), 'permissions', $missing ? ($authoritative ? ($connection['type'] === 'application' ? 'applicationBootstrapPending' : 'restoreDatabase') : 'metadataUnknown') : ((int) $result['hasAccess'] === 1 ? 'databaseExists' : 'databaseAccess'), ['database' => $database]);
        }
    }
    return $steps;
}

/** Run bounded, independent connection probes without exposing exceptions or echoing stdin. */
function diagnose(array $request): array
{
    $steps = [];
    foreach ($request['connections'] ?? [] as $connection) {
        $id = $connection['id'];
        try {
            validateConnection($connection);
            $tcp = probeTcp($connection);
            $steps[] = $tcp;
            if ($tcp['status'] !== 'passed') {
                $steps[] = diagnosticStep($id.'.sql', 'notChecked', 'network', 'tcpFirst');
                continue;
            }
            if (!in_array('sqlsrv', PDO::getAvailableDrivers(), true)) {
                $steps[] = diagnosticStep($id.'.sql', 'notChecked', 'docker', 'driverMissing');
                continue;
            }
            if ($connection['username'] === '' || $connection['password'] === '') {
                $steps[] = diagnosticStep($id.'.sql', 'notChecked', 'authentication', 'authorizationRequired');
                continue;
            }
            $pdo = connectSql($connection);
            $steps[] = diagnosticStep($id.'.sql', 'passed', 'authentication', 'sqlConnected', ['database' => $connection['database'], 'encrypt' => $connection['encrypt'], 'trustServerCertificate' => $connection['trust']]);
            try {
                $steps = array_merge($steps, readConnectionFacts($pdo, $connection));
            } catch (Throwable) {
                $steps[] = diagnosticStep($id.'.metadata', 'notChecked', 'permissions', 'metadataUnknown');
            }
            if ($connection['trust']) {
                $steps[] = diagnosticStep($id.'.trust', 'warning', 'tls', 'trustCertificate');
            }
            if (!$connection['encrypt']) {
                $steps[] = diagnosticStep($id.'.encrypt', 'warning', 'tls', 'encryptionOff');
            }
            $pdo = null;
        } catch (Throwable $exception) {
            $classification = classifyDriverError($exception);
            $steps[] = diagnosticStep($id.'.sql', 'failed', $classification['category'], $classification['reason']);
        }
    }
    return ['steps' => $steps];
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        $input = json_decode(stream_get_contents(STDIN), true, 64, JSON_THROW_ON_ERROR);
        echo json_encode(diagnose($input), JSON_THROW_ON_ERROR);
    } catch (Throwable) {
        echo json_encode(['steps' => [diagnosticStep('docker.probe', 'failed', 'docker', 'probeUnavailable')]]);
    }
}
