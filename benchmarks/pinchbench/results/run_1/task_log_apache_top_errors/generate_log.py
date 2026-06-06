import random
from datetime import datetime, timedelta

random.seed(42)
base = datetime(2024, 1, 15, 0, 0, 0)
lines = []

paths_404 = ['wp-login.php','admin/config.php','phpmyadmin/index.php','.env','backup/db.sql','wp-content/uploads/shell.php','xmlrpc.php','vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php','administrator/index.php','old/index.html']
perms = ['uploads/','config/','private/','logs/','backups/']
waf_words = ['select','union','drop','insert','script','alert','exec']
php_errors_list = [
    'Uncaught Error: Call to undefined function memcache_connect() in /var/www/html/app/Database.php on line 47',
    'Allowed memory size of 134217728 bytes exhausted (tried to allocate 20480 bytes) in /var/www/html/lib/Auth.php on line 203',
    'Uncaught PDOException: SQLSTATE[HY000]: General error in /var/www/html/src/UserController.php on line 89',
    'Maximum execution time of 30 seconds exceeded in /var/www/html/vendor/framework/Session.php on line 156',
    'Uncaught TypeError: Argument #1 must be of type string in /var/www/html/app/Database.php on line 312'
]
htaccess_errs = [
    "Invalid command 'RewriteEngine'",
    "Invalid command 'Deny'",
    "Syntax error on line 12",
    "AllowOverride not allowed here"
]

def ts(t):
    return t.strftime("%a %b %d %H:%M:%S.%f")[:-3] + " " + t.strftime("%Y")

# 1. File not found (404) - 180
for i in range(180):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    ip = '192.168.1.{}:{}'.format(random.randint(1,254), random.randint(40000,65535))
    p = random.choice(paths_404)
    lines.append((t, '[{}] [error] [client {}] File does not exist: /var/www/html/{}'.format(ts(t), ip, p)))

# 2. Permission denied - 95
for i in range(95):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    ip = '10.0.{}.{}:{}'.format(random.randint(0,255), random.randint(1,254), random.randint(40000,65535))
    p = random.choice(perms)
    lines.append((t, '[{}] [error] [client {}] (13)Permission denied: access to /var/www/html/{} failed'.format(ts(t), ip, p)))

# 3. ModSecurity WAF - 135
for i in range(135):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    c = random.choice(['203.0.113','198.51.100','192.0.2'])
    ip = '{}.{}:{}'.format(c, random.randint(1,254), random.randint(40000,65535))
    w = random.choice(waf_words)
    lid = '9{}'.format(random.randint(1000,9999))
    lnum = random.randint(100,999)
    lines.append((t, '[{}] [error] [client {}] ModSecurity: Access denied with code 403 (phase 2). Pattern match "\\\\b{}\\\\b" at REQUEST_URI. [file "/etc/apache2/modsecurity.d/rules.conf"] [line "{}"] [id "{}"] [msg "SQL Injection Attack Detected"] [severity "CRITICAL"]'.format(ts(t), ip, w, lnum, lid)))

# 4. SSL/TLS handshake failure - 85
for i in range(85):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    c = random.choice(['45.33.32','93.184.216','104.26.10'])
    ip = '{}.{}:{}'.format(c, random.randint(1,254), random.randint(40000,65535))
    host = random.choice(['www.example.com','api.mysite.com','cdn.example.org'])
    port = random.randint(1,65535)
    lines.append((t, '[{}] [error] [client {}] AH02032: SSL handshake failed: server {}:{}, referer: -'.format(ts(t), ip, host, port)))

# 5. PHP Fatal errors - 72
for i in range(72):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    ip = '172.16.{}.{}:{}'.format(random.randint(0,255), random.randint(1,254), random.randint(40000,65535))
    e = random.choice(php_errors_list)
    lines.append((t, '[{}] [error] [client {}] PHP Fatal error: {}'.format(ts(t), ip, e)))

# 6. Proxy/connect timeout - 55
for i in range(55):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    ip = '10.10.{}.{}:{}'.format(random.randint(0,255), random.randint(1,254), random.randint(40000,65535))
    proto = random.choice(['HTTP','AJP'])
    back = random.choice(['127.0.0.1','10.0.0.5','backend-01.internal'])
    port = random.choice([8080,8443,9090])
    lines.append((t, '[{}] [error] [client {}] (110)Connection timed out: proxy: {}: attempt to connect to {}:{} ({}) failed'.format(ts(t), ip, proto, back, port, back)))

# 7. mod_jk child init failure - 48
for i in range(48):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    lnum = random.randint(200,400)
    lines.append((t, '[{}] [error] mod_jk child init env.createBean2() factory error - jk_util.c {}: Failed to initialize worker env, check your workers.properties'.format(ts(t), lnum)))

# 8. env.createBean2() factory error - 42
for i in range(42):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    lnum = random.randint(200,400)
    lines.append((t, '[{}] [error] env.createBean2() factory error - jk_util.c {}: Could not create bean for worker type, verify your Tomcat configuration'.format(ts(t), lnum)))

# 9. .htaccess misconfiguration - 38
for i in range(38):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    ip = '192.168.{}.{}:{}'.format(random.randint(0,255), random.randint(1,254), random.randint(40000,65535))
    d = random.choice(['app','admin','api','portal'])
    e = random.choice(htaccess_errs)
    lines.append((t, '[{}] [error] [client {}] /var/www/html/{}/.htaccess: {}'.format(ts(t), ip, d, e)))

# 10. Premature end of script headers (CGI) - 28
for i in range(28):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    ip = '10.0.1.{}:{}'.format(random.randint(1,254), random.randint(40000,65535))
    c = random.choice(['index.cgi','form_handler.cgi','report.cgi','upload.cgi'])
    lines.append((t, '[{}] [error] [client {}] Premature end of script headers: {}'.format(ts(t), ip, c)))

# 11. Request body size exceeded - 22
for i in range(22):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    ip = '172.20.{}.{}:{}'.format(random.randint(0,255), random.randint(1,254), random.randint(40000,65535))
    limit = random.choice(['LimitRequestBody','upload_max_filesize'])
    lines.append((t, '[{}] [error] [client {}] Request body exceeds maximum size: {} limit'.format(ts(t), ip, limit)))

# 12. Core dump / segfault - 15
for i in range(15):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    pid = random.randint(1000,9999)
    status = random.choice(['139','11'])
    ref = random.choice(['https://www.example.com/app','-'])
    lines.append((t, '[{}] [error] child process {} exited with status {} -- Aborting, referer: {}'.format(ts(t), pid, status, ref)))

# 13. DNS resolution failure - 10
for i in range(10):
    t = base + timedelta(seconds=random.randint(0, 30*24*3600))
    ip = '203.0.113.{}:{}'.format(random.randint(1,254), random.randint(40000,65535))
    h = random.choice(['backend-app.local','cache-server.internal','db-replica.local','nonexistent-host.example.com'])
    lines.append((t, '[{}] [error] [client {}] proxy: DNS lookup failure for: {}'.format(ts(t), ip, h)))

lines.sort(key=lambda x: x[0])

with open('apache_error.log', 'w') as f:
    for t, line in lines:
        f.write(line + '\n')

print('Generated {} error log lines'.format(len(lines)))
