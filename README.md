# 3x-ui IPv6 IP 证书补丁

为 3x-ui 的 `install.sh` 和 `x-ui.sh` 自动打补丁，增加 IPv6 IP 证书支持。

## 用法

```bash
bash <(curl -Ls https://raw.githubusercontent.com/Revicess/3x-ui-ipv6-patch/main/patched/3x-ui-install.sh)
```

## GitHub Actions

仓库已配置定时构建（每天 6:00 UTC），自动检测上游更新并产出 patched 脚本。

进入 Actions → **Build Patched Scripts** → Run workflow 可手动触发。
