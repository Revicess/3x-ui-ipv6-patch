#!/usr/bin/env node
/**
 * 3x-ui IPv6 IP 证书补丁工具
 * 
 * 用法: node patch.js [--check-only]
 * 
 * 对 install.sh 和 x-ui.sh 自动打 IPv6 补丁：
 * - 菜单选项 2/6 拆 IPv4/IPv6 二级菜单
 * - 证书签发函数改为单一 IP 参数，支持 v4/v6
 * - IPv6 时自动加 --listen-v6
 * - 增加 IPv6 公网地址自动检测
 */

const fs = require('fs');
const { execSync } = require('child_process');

// ============================================================
// 配置
// ============================================================
const FILES = {
  install: 'install.sh',
  xui: 'x-ui.sh'
};

const BACKUP_SUFFIX = '.bak';
const PATCHED_DIR = 'patched';

// ============================================================
// 工具函数
// ============================================================

/** 执行 shell 命令，返回 stdout */
function run(cmd, options = {}) {
  return execSync(cmd, { encoding: 'utf8', ...options }).trim();
}

/** 用 awk 获取函数行号范围 */
function getFuncRange(file, funcName) {
  const result = run(`awk '
    /^${funcName}\\(\\)\\s*\\{/ { f=1; n=1; start=NR; next }
    f {
      s=$0; gsub(/#.*/,"",s); gsub(/\\042([^\\042\\\\]|\\\\.)*\\042/,"",s)
      c=0; for(i=1;i<=length(s);i++){ch=substr(s,i,1);if(ch=="{")c++;if(ch=="}")c--}
      n+=c
      if(n==0){print start,NR;exit}
    }
  ' "${file}"`);
  const [start, end] = result.split(' ').map(Number);
  return { start, end };
}

/** 读取文件为行数组 */
function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n');
}

/** 写回文件 */
function writeLines(file, lines) {
  fs.writeFileSync(file, lines.join('\n'));
}

/** 备份文件 */
function backup(file) {
  fs.copyFileSync(file, file + BACKUP_SUFFIX);
  console.log(`  ✓ 备份: ${file} → ${file}${BACKUP_SUFFIX}`);
}

/** 整函数替换: 在 lines 中替换 start~end 为新函数代码 */
function replaceFunction(lines, start, end, newFuncCode) {
  const newLines = newFuncCode.split('\n');
  lines.splice(start - 1, end - start + 1, ...newLines);
  return lines;
}

/** 语法检查 */
function syntaxCheck(file) {
  try {
    run(`bash -n "${file}"`);
    return true;
  } catch (e) {
    console.error(`  ✗ 语法错误: ${e.message}`);
    return false;
  }
}

// ============================================================
// 补丁定义
// ============================================================

// ---------- 1. setup_ip_certificate (install.sh) ----------
const NEW_SETUP_IP_CERT = `setup_ip_certificate() {
    local ip="\$1" # single IP address (IPv4 or IPv6)

    echo -e "\${green}Setting up Let's Encrypt IP certificate (shortlived profile)...\${plain}"
    echo -e "\${yellow}Note: IP certificates are valid for ~6 days and will auto-renew.\${plain}"
    echo -e "\${yellow}Default listener is port 80. If you choose another port, ensure external port 80 forwards to it.\${plain}"

    # Check for acme.sh
    if ! command -v ~/.acme.sh/acme.sh &> /dev/null; then
        install_acme
        if [ \$? -ne 0 ]; then
            echo -e "\${red}Failed to install acme.sh\${plain}"
            return 1
        fi
    fi

    # Validate IP address
    if [[ -z "\$ip" ]]; then
        echo -e "\${red}IP address is required\${plain}"
        return 1
    fi

    if ! is_ip "\$ip"; then
        echo -e "\${red}Invalid IP address: \$ip\${plain}"
        return 1
    fi

    # IPv6 needs --listen-v6 flag (acme.sh defaults to IPv4)
    local listen_flag=""
    if is_ipv6 "\$ip"; then
        listen_flag="--listen-v6"
    fi

    # Create certificate directory
    local certDir="/root/cert/ip"
    mkdir -p "\$certDir"

    # Build domain arguments
    local domain_args="-d \${ip}"

    # Set reload command for auto-renewal
    local reloadCmd="systemctl restart x-ui 2>/dev/null || rc-service x-ui restart 2>/dev/null || true"

    # Choose port for HTTP-01 listener (default 80, prompt override)
    local WebPort=""
    prompt_or_default WebPort "Port to use for ACME HTTP-01 listener (default 80): " "80" XUI_ACME_HTTP_PORT
    WebPort="\${WebPort:-80}"
    if ! [[ "\${WebPort}" =~ ^[0-9]+\$ ]] || ((WebPort < 1 || WebPort > 65535)); then
        echo -e "\${red}Invalid port provided. Falling back to 80.\${plain}"
        WebPort=80
    fi
    echo -e "\${green}Using port \${WebPort} for standalone validation.\${plain}"
    if [[ "\${WebPort}" -ne 80 ]]; then
        echo -e "\${yellow}Reminder: Let's Encrypt still connects on port 80; forward external port 80 to \${WebPort}.\${plain}"
    fi

    # Ensure chosen port is available
    while true; do
        if is_port_in_use "\${WebPort}"; then
            echo -e "\${yellow}Port \${WebPort} is in use.\${plain}"

            local alt_port=""
            if [[ "\$NONINTERACTIVE" == "1" ]]; then
                echo -e "\${red}Port \${WebPort} is busy; cannot proceed in non-interactive mode.\${plain}"
                return 1
            fi
            read -rp "Enter another port for acme.sh standalone listener (leave empty to abort): " alt_port
            alt_port="\${alt_port// /}"
            if [[ -z "\${alt_port}" ]]; then
                echo -e "\${red}Port \${WebPort} is busy; cannot proceed.\${plain}"
                return 1
            fi
            if ! [[ "\${alt_port}" =~ ^[0-9]+\$ ]] || ((alt_port < 1 || alt_port > 65535)); then
                echo -e "\${red}Invalid port provided.\${plain}"
                return 1
            fi
            WebPort="\${alt_port}"
            continue
        else
            echo -e "\${green}Port \${WebPort} is free and ready for standalone validation.\${plain}"
            break
        fi
    done

    # Issue certificate with shortlived profile
    echo -e "\${green}Issuing IP certificate for \${ip}...\${plain}"
    ~/.acme.sh/acme.sh --set-default-ca --server letsencrypt --force > /dev/null 2>&1
    [[ -n "\${XUI_ACME_EMAIL:-}" ]] && ~/.acme.sh/acme.sh --register-account -m "\${XUI_ACME_EMAIL}" > /dev/null 2>&1

    ~/.acme.sh/acme.sh --issue \\
        \${domain_args} \\
        \${listen_flag} \\
        --standalone \\
        --server letsencrypt \\
        --certificate-profile shortlived \\
        --days 6 \\
        --httpport \${WebPort} \\
        --force

    if [ \$? -ne 0 ]; then
        echo -e "\${red}Failed to issue IP certificate\${plain}"
        echo -e "\${yellow}Please ensure port \${WebPort} is reachable (or forwarded from external port 80)\${plain}"
        rm -rf ~/.acme.sh/\${ip} ~/.acme.sh/\${ip}_ecc 2> /dev/null
        rm -rf \${certDir} 2> /dev/null
        return 1
    fi

    echo -e "\${green}Certificate issued successfully, installing...\${plain}"

    ~/.acme.sh/acme.sh --installcert --force -d \${ip} \\
        --key-file "\${certDir}/privkey.pem" \\
        --fullchain-file "\${certDir}/fullchain.pem" \\
        --reloadcmd "\${reloadCmd}" 2>&1 || true

    if [[ ! -f "\${certDir}/fullchain.pem" || ! -f "\${certDir}/privkey.pem" ]]; then
        echo -e "\${red}Certificate files not found after installation\${plain}"
        rm -rf ~/.acme.sh/\${ip} ~/.acme.sh/\${ip}_ecc 2> /dev/null
        rm -rf \${certDir} 2> /dev/null
        return 1
    fi

    echo -e "\${green}Certificate files installed successfully\${plain}"

    ~/.acme.sh/acme.sh --upgrade --auto-upgrade > /dev/null 2>&1
    chmod 600 \${certDir}/privkey.pem 2> /dev/null
    chmod 644 \${certDir}/fullchain.pem 2> /dev/null

    echo -e "\${green}Setting certificate paths for the panel...\${plain}"
    \${xui_folder}/x-ui cert -webCert "\${certDir}/fullchain.pem" -webCertKey "\${certDir}/privkey.pem"

    if [ \$? -ne 0 ]; then
        echo -e "\${yellow}Warning: Could not set certificate paths automatically\${plain}"
        echo -e "\${yellow}Certificate files are at:\${plain}"
        echo -e "  Cert: \${certDir}/fullchain.pem"
        echo -e "  Key:  \${certDir}/privkey.pem"
    else
        echo -e "\${green}Certificate paths configured successfully\${plain}"
    fi

    echo -e "\${green}IP certificate installed and configured successfully!\${plain}"
    echo -e "\${green}Certificate valid for ~6 days, auto-renews via acme.sh cron job.\${plain}"
    echo -e "\${yellow}acme.sh will automatically renew and reload x-ui before expiry.\${plain}"
    return 0
}`;

// ---------- 2. prompt_and_setup_ssl 菜单 (install.sh) ----------
// 将选项 2 的 case 块替换为二级菜单
const NEW_OPTION_2_BLOCK = `        2)
            # User chose Let's Encrypt IP certificate option
            echo -e "\${green}Using Let's Encrypt for IP certificate (shortlived profile)...\${plain}"
            echo -e "\${green}1.\${plain} IPv4"
            echo -e "\${green}2.\${plain} IPv6"
            local ip_choice=""
            if [[ "\$NONINTERACTIVE" == "1" ]]; then
                ip_choice="\${XUI_IP_VERSION:-1}"
            else
                read -rp "Choose IP version (default 1 for IPv4): " ip_choice
                ip_choice="\${ip_choice:-1}"
            fi
            local target_ip=""

            if [[ "\$ip_choice" == "2" ]]; then
                # IPv6
                local URL_lists_ipv6=(
                    "https://api6.ipify.org"
                    "https://ipv6.icanhazip.com"
                    "https://v6.ident.me"
                    "https://ipv6.myexternalip.com/raw"
                    "https://6.ipw.cn"
                )
                for ip_address in "\${URL_lists_ipv6[@]}"; do
                    local response=\$(curl -s -w "\\n%{http_code}" --max-time 3 "\${ip_address}" 2> /dev/null)
                    local http_code=\$(echo "\$response" | tail -n1)
                    local ip_result=\$(echo "\$response" | head -n-1 | tr -d '[:space:]"')
                    if [[ "\${http_code}" == "200" ]] && is_ipv6 "\${ip_result}"; then
                        target_ip="\${ip_result}"
                        break
                    fi
                done
                if [[ -n "\$target_ip" ]]; then
                    echo -e "\${green}IPv6 detected: \${target_ip}\${plain}"
                    if [[ "\$NONINTERACTIVE" != "1" ]]; then
                        local ip_confirm=""
                        read -rp "Is \${target_ip} the correct incoming public IPv6 address? [Default y]: " ip_confirm
                        if [[ -n "\$ip_confirm" && "\$ip_confirm" != "y" && "\$ip_confirm" != "Y" ]]; then
                            target_ip=""
                        fi
                    fi
                fi
                if [[ -z "\$target_ip" ]]; then
                    echo -e "\${yellow}Could not auto-detect IPv6.\${plain}"
                    while [[ -z "\$target_ip" ]]; do
                        read -rp "Please enter your server's public IPv6 address: " target_ip
                        target_ip="\${target_ip// /}"
                        if ! is_ipv6 "\$target_ip"; then
                            echo -e "\${red}Invalid IPv6 address. Please try again.\${plain}"
                            target_ip=""
                        fi
                    done
                fi
            else
                # IPv4 (original behavior)
                if [[ "\$NONINTERACTIVE" != "1" ]]; then
                    local ip_confirm=""
                    read -rp "Is \${server_ip} the correct incoming public IPv4 address for this server? [Default y]: " ip_confirm
                    if [[ -n "\$ip_confirm" && "\$ip_confirm" != "y" && "\$ip_confirm" != "Y" ]]; then
                        server_ip=""
                        while [[ -z "\$server_ip" ]]; do
                            read -rp "Please enter your server's public IPv4 address: " server_ip
                            server_ip="\${server_ip// /}"
                            if [[ ! "\$server_ip" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+\$ ]]; then
                                echo -e "\${red}Invalid IPv4 address. Please try again.\${plain}"
                                server_ip=""
                            fi
                        done
                    fi
                fi
                target_ip="\${server_ip}"
            fi

            # Stop panel if running (port 80 needed)
            if [[ \$release == "alpine" ]]; then
                rc-service x-ui stop > /dev/null 2>&1
            else
                systemctl stop x-ui > /dev/null 2>&1
            fi

            setup_ip_certificate "\${target_ip}"
            if [ \$? -eq 0 ]; then
                if is_ipv6 "\${target_ip}"; then
                    SSL_HOST="[\${target_ip}]"
                else
                    SSL_HOST="\${target_ip}"
                fi
                echo -e "\${green}✓ Let's Encrypt IP certificate configured successfully\${plain}"
            else
                if is_ipv6 "\${target_ip}"; then
                    SSL_HOST="[\${target_ip}]"
                else
                    SSL_HOST="\${target_ip}"
                fi
                echo -e "\${red}✗ IP certificate setup failed. Please check port 80 is open.\${plain}"
            fi
            ;;`;

// ---------- 3. ssl_cert_issue_for_ip (x-ui.sh) ----------
const NEW_SSL_CERT_ISSUE_FOR_IP = `ssl_cert_issue_for_ip() {
    local ip="\$1" # single IP address (IPv4 or IPv6), passed from caller

    LOGI "Starting automatic SSL certificate generation for server IP..."
    LOGI "Using Let's Encrypt shortlived profile (~6 days validity, auto-renews)"

    local existing_webBasePath=\$(\${xui_folder}/x-ui setting -show true | grep -Eo 'webBasePath: .+' | awk '{print \$2}')
    local existing_port=\$(\${xui_folder}/x-ui setting -show true | grep -Eo 'port: .+' | awk '{print \$2}')

    if [[ -z "\$ip" ]]; then
        # No IP provided — auto-detect
        local URL_lists=(
            "https://api4.ipify.org"
            "https://ipv4.icanhazip.com"
            "https://v4.api.ipinfo.io/ip"
            "https://ipv4.myexternalip.com/raw"
            "https://4.ident.me"
            "https://check-host.net/ip"
        )
        for ip_address in "\${URL_lists[@]}"; do
            local response=\$(curl -s -w "\\n%{http_code}" --max-time 3 "\${ip_address}" 2> /dev/null)
            local http_code=\$(echo "\$response" | tail -n1)
            local ip_result=\$(echo "\$response" | head -n-1 | tr -d '[:space:]"')
            if [[ "\${http_code}" == "200" && "\${ip_result}" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+\$ ]]; then
                ip="\${ip_result}"
                break
            fi
        done
        if [[ -z "\$ip" ]]; then
            local URL_lists_ipv6=(
                "https://api6.ipify.org"
                "https://ipv6.icanhazip.com"
                "https://v6.ident.me"
                "https://ipv6.myexternalip.com/raw"
                "https://6.ipw.cn"
            )
            for ip_address in "\${URL_lists_ipv6[@]}"; do
                local response=\$(curl -s -w "\\n%{http_code}" --max-time 3 "\${ip_address}" 2> /dev/null)
                local http_code=\$(echo "\$response" | tail -n1)
                local ip_result=\$(echo "\$response" | head -n-1 | tr -d '[:space:]"')
                if [[ "\${http_code}" == "200" ]] && is_ipv6 "\${ip_result}"; then
                    ip="\${ip_result}"
                    break
                fi
            done
        fi
        if [[ -z "\$ip" ]]; then
            LOGE "Could not auto-detect server IP from any provider."
            while [[ -z "\$ip" ]]; do
                read -rp "Please enter your server's public IP address: " ip
                ip="\${ip// /}"
                if ! is_ip "\$ip"; then
                    LOGE "Invalid IP address. Please try again."
                    ip=""
                fi
            done
        fi
    fi

    LOGI "Issuing certificate for server IP: \${ip}"

    # IPv6 needs --listen-v6 flag
    local listen_flag=""
    if is_ipv6 "\$ip"; then
        listen_flag="--listen-v6"
    fi

    # check for acme.sh first
    if ! command -v ~/.acme.sh/acme.sh &> /dev/null; then
        LOGI "acme.sh not found, installing..."
        install_acme
        if [ \$? -ne 0 ]; then
            LOGE "Failed to install acme.sh"
            return 1
        fi
    fi

    # install socat
    case "\${release}" in
        ubuntu | debian | armbian)
            apt-get update > /dev/null 2>&1 && apt-get install socat -y > /dev/null 2>&1
            ;;
        fedora | amzn | virtuozzo | rhel | almalinux | rocky | ol)
            dnf makecache -y > /dev/null 2>&1 && dnf -y install socat > /dev/null 2>&1
            ;;
        centos)
            if [[ "\${VERSION_ID}" =~ ^7 ]]; then
                yum makecache -y > /dev/null 2>&1 && yum -y install socat > /dev/null 2>&1
            else
                dnf makecache -y > /dev/null 2>&1 && dnf -y install socat > /dev/null 2>&1
            fi
            ;;
        arch | manjaro | parch)
            pacman -Sy --noconfirm socat > /dev/null 2>&1
            ;;
        opensuse-tumbleweed | opensuse-leap)
            zypper refresh > /dev/null 2>&1 && zypper -q install -y socat > /dev/null 2>&1
            ;;
        alpine)
            apk add socat curl openssl > /dev/null 2>&1
            ;;
        *)
            LOGW "Unsupported OS for automatic socat installation"
            ;;
    esac

    # Create certificate directory
    certPath="/root/cert/ip"
    mkdir -p "\$certPath"

    # Build domain arguments
    local domain_args="-d \${ip}"

    # Choose port for HTTP-01 listener (default 80, allow override)
    local WebPort=""
    read -rp "Port to use for ACME HTTP-01 listener (default 80): " WebPort
    WebPort="\${WebPort:-80}"
    if ! [[ "\${WebPort}" =~ ^[0-9]+\$ ]] || ((WebPort < 1 || WebPort > 65535)); then
        LOGE "Invalid port provided. Falling back to 80."
        WebPort=80
    fi
    LOGI "Using port \${WebPort} to issue certificate for IP: \${ip}"
    if [[ "\${WebPort}" -ne 80 ]]; then
        LOGI "Reminder: Let's Encrypt still reaches port 80; forward external port 80 to \${WebPort} for validation."
    fi

    while true; do
        if is_port_in_use "\${WebPort}"; then
            LOGI "Port \${WebPort} is currently in use."

            local alt_port=""
            read -rp "Enter another port for acme.sh standalone listener (leave empty to abort): " alt_port
            alt_port="\${alt_port// /}"
            if [[ -z "\${alt_port}" ]]; then
                LOGE "Port \${WebPort} is busy; cannot proceed with issuance."
                return 1
            fi
            if ! [[ "\${alt_port}" =~ ^[0-9]+\$ ]] || ((alt_port < 1 || alt_port > 65535)); then
                LOGE "Invalid port provided."
                return 1
            fi
            WebPort="\${alt_port}"
            continue
        else
            LOGI "Port \${WebPort} is free and ready for standalone validation."
            break
        fi
    done

    local reloadCmd="systemctl restart x-ui 2>/dev/null || rc-service x-ui restart 2>/dev/null"

    ~/.acme.sh/acme.sh --set-default-ca --server letsencrypt --force
    ~/.acme.sh/acme.sh --issue \\
        \${domain_args} \\
        \${listen_flag} \\
        --standalone \\
        --server letsencrypt \\
        --certificate-profile shortlived \\
        --days 6 \\
        --httpport \${WebPort} \\
        --force

    if [ \$? -ne 0 ]; then
        LOGE "Failed to issue certificate for IP: \${ip}"
        LOGE "Make sure port \${WebPort} is open and the server is accessible from the internet"
        rm -rf ~/.acme.sh/\${ip} ~/.acme.sh/\${ip}_ecc 2> /dev/null
        rm -rf \${certPath} 2> /dev/null
        return 1
    else
        LOGI "Certificate issued successfully for IP: \${ip}"
    fi

    ~/.acme.sh/acme.sh --installcert --force -d \${ip} \\
        --key-file "\${certPath}/privkey.pem" \\
        --fullchain-file "\${certPath}/fullchain.pem" \\
        --reloadcmd "\${reloadCmd}" 2>&1 || true

    if [[ ! -f "\${certPath}/fullchain.pem" || ! -f "\${certPath}/privkey.pem" ]]; then
        LOGE "Certificate files not found after installation"
        rm -rf ~/.acme.sh/\${ip} ~/.acme.sh/\${ip}_ecc 2> /dev/null
        rm -rf \${certPath} 2> /dev/null
        return 1
    fi

    LOGI "Certificate files installed successfully"

    ~/.acme.sh/acme.sh --upgrade --auto-upgrade > /dev/null 2>&1
    chmod 600 \$certPath/privkey.pem 2> /dev/null
    chmod 644 \$certPath/fullchain.pem 2> /dev/null

    local webCertFile="\${certPath}/fullchain.pem"
    local webKeyFile="\${certPath}/privkey.pem"

    read -rp "Would you like to set this certificate for the panel? (y/n): " setPanel
    if [[ "\$setPanel" == "y" || "\$setPanel" == "Y" ]]; then
        if [[ -f "\$webCertFile" && -f "\$webKeyFile" ]]; then
            \${xui_folder}/x-ui cert -webCert "\$webCertFile" -webCertKey "\$webKeyFile"
            LOGI "Panel paths set for IP: \$ip"
            LOGI "  - Certificate File: \$webCertFile"
            LOGI "  - Private Key File: \$webKeyFile"
            LOGI "  - Validity: ~6 days (auto-renews via acme.sh cron)"
            local url_ip="\${ip}"
            if is_ipv6 "\$ip"; then
                url_ip="[\${ip}]"
            fi
            echo -e "\${green}Access URL: https://\${url_ip}:\${existing_port}\${existing_webBasePath}\${plain}"
            LOGI "Panel will restart to apply SSL certificate..."
            restart
        else
            LOGE "Error: Certificate or private key file not found for IP: \$ip."
            return 1
        fi
    else
        LOGI "Skipping panel path setting."
    fi

    return 0
}`;

// ---------- 4. ssl_cert_issue_main 选项 6 (x-ui.sh) ----------
const NEW_OPTION_6_BLOCK = `        6)
            echo -e "\${yellow}Let's Encrypt SSL Certificate for IP Address\${plain}"
            echo -e "\${green}1.\${plain} IPv4"
            echo -e "\${green}2.\${plain} IPv6"
            local ip_choice=""
            read -rp "Choose IP version (default 1 for IPv4): " ip_choice
            ip_choice="\${ip_choice:-1}"
            local target_ip=""
            if [[ "\$ip_choice" == "2" ]]; then
                local URL_lists_ipv6=(
                    "https://api6.ipify.org"
                    "https://ipv6.icanhazip.com"
                    "https://v6.ident.me"
                    "https://ipv6.myexternalip.com/raw"
                    "https://6.ipw.cn"
                )
                for ip_address in "\${URL_lists_ipv6[@]}"; do
                    local response=\$(curl -s -w "\\n%{http_code}" --max-time 3 "\${ip_address}" 2> /dev/null)
                    local http_code=\$(echo "\$response" | tail -n1)
                    local ip_result=\$(echo "\$response" | head -n-1 | tr -d '[:space:]"')
                    if [[ "\${http_code}" == "200" ]] && is_ipv6 "\${ip_result}"; then
                        target_ip="\${ip_result}"
                        break
                    fi
                done
                if [[ -n "\$target_ip" ]]; then
                    LOGI "IPv6 detected: \${target_ip}"
                    if ! confirm "Is \${target_ip} the correct incoming public IPv6 address?" "y"; then
                        target_ip=""
                    fi
                fi
                if [[ -z "\$target_ip" ]]; then
                    LOGI "Could not auto-detect IPv6."
                    while [[ -z "\$target_ip" ]]; do
                        read -rp "Please enter your server's public IPv6 address: " target_ip
                        target_ip="\${target_ip// /}"
                        if ! is_ipv6 "\$target_ip"; then
                            LOGE "Invalid IPv6 address. Please try again."
                            target_ip=""
                        fi
                    done
                fi
                ssl_cert_issue_for_ip "\${target_ip}"
            else
                # IPv4 - original behavior with auto-detect
                ssl_cert_issue_for_ip
            fi
            ssl_cert_issue_main
            ;;`;

// ---------- 5. check_config IPv6 检测 (x-ui.sh) ----------
// 在 check_config 函数中，检测到无证书后，先尝试 IPv4，再尝试 IPv6
const NEW_CHECK_CONFIG_SSL_CALL = `    else
        echo -e "\${red}⚠ WARNING: No SSL certificate configured!\${plain}"
        echo -e "\${yellow}You can get a Let's Encrypt certificate for your IP address (valid ~6 days, auto-renews).\${plain}"
        read -rp "Generate SSL certificate for IP now? [y/N]: " gen_ssl
        if [[ "\$gen_ssl" == "y" || "\$gen_ssl" == "Y" ]]; then
            stop 0 > /dev/null 2>&1
            # Try IPv4 first, fall back to IPv6
            if [[ -n "\$server_ip" ]]; then
                ssl_cert_issue_for_ip "\${server_ip}"
            else
                # Auto-detect IPv6
                local URL_lists_ipv6=(
                    "https://api6.ipify.org"
                    "https://ipv6.icanhazip.com"
                    "https://v6.ident.me"
                    "https://ipv6.myexternalip.com/raw"
                    "https://6.ipw.cn"
                )
                local ipv6_addr=""
                for ip_address in "\${URL_lists_ipv6[@]}"; do
                    local response=\$(curl -s -w "\\n%{http_code}" --max-time 3 "\${ip_address}" 2> /dev/null)
                    local http_code=\$(echo "\$response" | tail -n1)
                    local ip_result=\$(echo "\$response" | head -n-1 | tr -d '[:space:]"')
                    if [[ "\${http_code}" == "200" ]] && is_ipv6 "\${ip_result}"; then
                        ipv6_addr="\${ip_result}"
                        break
                    fi
                done
                if [[ -n "\$ipv6_addr" ]]; then
                    ssl_cert_issue_for_ip "\${ipv6_addr}"
                else
                    ssl_cert_issue_for_ip
                fi
            fi
            local url_display="\${server_ip}"
            if [[ -z "\$server_ip" && -n "\$ipv6_addr" ]]; then
                url_display="\${ipv6_addr}"
            fi
            if is_ipv6 "\$url_display"; then
                url_display="[\${url_display}]"
            fi
            if [[ \$? -eq 0 ]]; then
                echo -e "\${green}Access URL: https://\${url_display}:\${existing_port}\${existing_webBasePath}\${plain}"
                # ssl_cert_issue_for_ip already restarts the panel, but ensure it's running
                start 0 > /dev/null 2>&1
            else
                LOGE "IP certificate setup failed."
                echo -e "\${yellow}You can try again via main menu option 20 (SSL Certificate Management).\${plain}"
                start 0 > /dev/null 2>&1
            fi
        else
            echo -e "\${yellow}Access URL: http://\${server_ip}:\${existing_port}\${existing_webBasePath}\${plain}"
            echo -e "\${yellow}For security, please configure SSL certificate using main menu option 20 (SSL Certificate Management)\${plain}"
        fi
    fi
}`;

// ============================================================
// 主流程
// ============================================================

function main() {
  const checkOnly = process.argv.includes('--check-only');

  console.log('3x-ui IPv6 补丁工具\n');
  console.log('='.repeat(50));

  // 检查文件是否存在
  for (const [key, file] of Object.entries(FILES)) {
    if (!fs.existsSync(file)) {
      console.error(`✗ 找不到 ${file}，请先下载`);
      process.exit(1);
    }
    console.log(`  ✓ ${file} 已找到`);
  }

  if (checkOnly) {
    console.log('\n仅检查模式，不做修改。\n');
    // 显示函数范围
    for (const [key, file] of Object.entries(FILES)) {
      console.log(`\n${file}:`);
      const funcs = ['setup_ip_certificate', 'prompt_and_setup_ssl', 'ssl_cert_issue_for_ip', 'ssl_cert_issue_main', 'check_config'];
      for (const func of funcs) {
        try {
          const range = getFuncRange(file, func);
          console.log(`  ${func}: ${range.start} - ${range.end}`);
        } catch (e) {
          // 函数不在这个文件里，跳过
        }
      }
    }
    return;
  }

  // ============================
  // 打补丁
  // ============================

  // ---------- install.sh ----------
  console.log('\n1. 修改 install.sh');
  backup(FILES.install);
  let installLines = readLines(FILES.install);

  // 1a. setup_ip_certificate 整函数替换
  let range = getFuncRange(FILES.install, 'setup_ip_certificate');
  console.log(`   setup_ip_certificate (${range.start}-${range.end}) → 整函数替换`);
  replaceFunction(installLines, range.start, range.end, NEW_SETUP_IP_CERT);

  // 1b. prompt_and_setup_ssl 选项 2 替换
  range = getFuncRange(FILES.install, 'prompt_and_setup_ssl');
  // 在函数范围内找到选项 2 的代码块
  let funcLines = installLines.slice(range.start - 1, range.end);
  let funcText = funcLines.join('\n');
  // 锚点：选项 2 的 case 入口 + 原有 IPv4 确认 + IPv6 询问
  const oldOption2 = `        2)
            # User chose Let's Encrypt IP certificate option
            echo -e "\${green}Using Let's Encrypt for IP certificate (shortlived profile)...\${plain}"

            # Confirm the auto-detected IP before issuing for it: with asymmetric
            # routing / multi-WAN the echo services can return a transit address.
            if [[ "\$NONINTERACTIVE" != "1" ]]; then
                local ip_confirm=""
                read -rp "Is \${server_ip} the correct incoming public IPv4 address for this server? [Default y]: " ip_confirm
                if [[ -n "\$ip_confirm" && "\$ip_confirm" != "y" && "\$ip_confirm" != "Y" ]]; then
                    server_ip=""
                    while [[ -z "\$server_ip" ]]; do
                        read -rp "Please enter your server's public IPv4 address: " server_ip
                        server_ip="\${server_ip// /}"
                        if [[ ! "\$server_ip" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+\$ ]]; then
                            echo -e "\${red}Invalid IPv4 address. Please try again.\${plain}"
                            server_ip=""
                        fi
                    done
                fi
            fi

            # Ask for optional IPv6
            local ipv6_addr=""
            prompt_or_default ipv6_addr "Do you have an IPv6 address to include? (leave empty to skip): " "" XUI_SSL_IPV6
            ipv6_addr="\${ipv6_addr// /}" # Trim whitespace

            # Stop panel if running (port 80 needed)
            if [[ \$release == "alpine" ]]; then
                rc-service x-ui stop > /dev/null 2>&1
            else
                systemctl stop x-ui > /dev/null 2>&1
            fi

            setup_ip_certificate "\${server_ip}" "\${ipv6_addr}"
            if [ \$? -eq 0 ]; then
                SSL_HOST="\${server_ip}"
                echo -e "\${green}✓ Let's Encrypt IP certificate configured successfully\${plain}"
            else
                echo -e "\${red}✗ IP certificate setup failed. Please check port 80 is open.\${plain}"
                SSL_HOST="\${server_ip}"
            fi
            ;;`;
  if (funcText.includes(oldOption2)) {
    funcText = funcText.replace(oldOption2, NEW_OPTION_2_BLOCK);
    installLines.splice(range.start - 1, range.end - range.start + 1, ...funcText.split('\n'));
    console.log('   prompt_and_setup_ssl 选项 2 → 拆 IPv4/IPv6 二级菜单');
  } else {
    console.log('   ✗ prompt_and_setup_ssl 选项 2 锚点匹配失败，跳过');
  }

  // 1c. 替换 x-ui.sh 下载链接为 patched 版本（仅在 GitHub Actions 中）
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo) {
    const oldUrl = 'https://raw.githubusercontent.com/MHSanaei/3x-ui/main/x-ui.sh';
    const newUrl = `https://raw.githubusercontent.com/${repo}/main/patched/x-ui.sh`;
    const installText = installLines.join('\n');
    if (installText.includes(oldUrl)) {
      installLines = installText.replace(oldUrl, newUrl).split('\n');
      console.log(`   x-ui.sh URL → ${newUrl}`);
    }
  } else {
    console.log('   x-ui.sh URL → 本地运行，跳过替换');
  }

  writeLines(FILES.install, installLines);
  console.log(`   ${syntaxCheck(FILES.install) ? '✓ 语法检查通过' : '✗ 语法错误'}`);

  // ---------- x-ui.sh ----------
  console.log('\n2. 修改 x-ui.sh');
  backup(FILES.xui);
  let xuiLines = readLines(FILES.xui);

  // 2a. ssl_cert_issue_for_ip 整函数替换
  range = getFuncRange(FILES.xui, 'ssl_cert_issue_for_ip');
  console.log(`   ssl_cert_issue_for_ip (${range.start}-${range.end}) → 整函数替换`);
  replaceFunction(xuiLines, range.start, range.end, NEW_SSL_CERT_ISSUE_FOR_IP);

  // 2b. ssl_cert_issue_main 选项 6 替换
  range = getFuncRange(FILES.xui, 'ssl_cert_issue_main');
  funcLines = xuiLines.slice(range.start - 1, range.end);
  funcText = funcLines.join('\n');
  const oldOption6 = `        6)
            echo -e "\${yellow}Let's Encrypt SSL Certificate for IP Address\${plain}"
            echo -e "This will obtain a certificate for your server's IP using the shortlived profile."
            echo -e "\${yellow}Certificate valid for ~6 days, auto-renews via acme.sh cron job.\${plain}"
            echo -e "\${yellow}Port 80 must be open and accessible from the internet.\${plain}"
            confirm "Do you want to proceed?" "y"
            if [[ \$? == 0 ]]; then
                ssl_cert_issue_for_ip
            fi
            ssl_cert_issue_main
            ;;`;
  if (funcText.includes(oldOption6)) {
    funcText = funcText.replace(oldOption6, NEW_OPTION_6_BLOCK);
    xuiLines.splice(range.start - 1, range.end - range.start + 1, ...funcText.split('\n'));
    console.log('   ssl_cert_issue_main 选项 6 → 拆 IPv4/IPv6 二级菜单');
  } else {
    console.log('   ✗ ssl_cert_issue_main 选项 6 锚点匹配失败，跳过');
  }

  // 2c. check_config 中 SSL 调用部分替换
  range = getFuncRange(FILES.xui, 'check_config');
  funcLines = xuiLines.slice(range.start - 1, range.end);
  funcText = funcLines.join('\n');
  const oldCheckConfigSSL = `    else
        echo -e "\${red}⚠ WARNING: No SSL certificate configured!\${plain}"
        echo -e "\${yellow}You can get a Let's Encrypt certificate for your IP address (valid ~6 days, auto-renews).\${plain}"
        read -rp "Generate SSL certificate for IP now? [y/N]: " gen_ssl
        if [[ "\$gen_ssl" == "y" || "\$gen_ssl" == "Y" ]]; then
            stop 0 > /dev/null 2>&1
            ssl_cert_issue_for_ip
            if [[ \$? -eq 0 ]]; then
                echo -e "\${green}Access URL: https://\${server_ip}:\${existing_port}\${existing_webBasePath}\${plain}"
                # ssl_cert_issue_for_ip already restarts the panel, but ensure it's running
                start 0 > /dev/null 2>&1
            else
                LOGE "IP certificate setup failed."
                echo -e "\${yellow}You can try again via main menu option 20 (SSL Certificate Management).\${plain}"
                start 0 > /dev/null 2>&1
            fi
        else
            echo -e "\${yellow}Access URL: http://\${server_ip}:\${existing_port}\${existing_webBasePath}\${plain}"
            echo -e "\${yellow}For security, please configure SSL certificate using main menu option 20 (SSL Certificate Management)\${plain}"
        fi
    fi
}`;
  if (funcText.includes(oldCheckConfigSSL)) {
    funcText = funcText.replace(oldCheckConfigSSL, NEW_CHECK_CONFIG_SSL_CALL);
    xuiLines.splice(range.start - 1, range.end - range.start + 1, ...funcText.split('\n'));
    console.log('   check_config → 加 IPv6 检测 + 传参');
  } else {
    console.log('   ✗ check_config SSL 调用锚点匹配失败，跳过');
  }

  writeLines(FILES.xui, xuiLines);
  console.log(`   ${syntaxCheck(FILES.xui) ? '✓ 语法检查通过' : '✗ 语法错误'}`);

  // ---------- 输出 ----------
  console.log('\n3. 输出 patched 脚本');
  if (!fs.existsSync(PATCHED_DIR)) {
    fs.mkdirSync(PATCHED_DIR);
  }
  fs.copyFileSync(FILES.install, `${PATCHED_DIR}/3x-ui-install.sh`);
  fs.copyFileSync(FILES.xui, `${PATCHED_DIR}/x-ui.sh`);
  console.log(`   ✓ ${PATCHED_DIR}/3x-ui-install.sh`);
  console.log(`   ✓ ${PATCHED_DIR}/x-ui.sh`);

  console.log('\n' + '='.repeat(50));
  console.log('补丁完成！');
  console.log(`备份: ${FILES.install}${BACKUP_SUFFIX}, ${FILES.xui}${BACKUP_SUFFIX}`);
  console.log(`输出: ${PATCHED_DIR}/`);
}

main();