#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
node scripts/package-release.mjs
result=$?
if (( result == 0 )); then
  echo "打包完成，安装包在 release 的新版本目录。"
else
  echo "打包失败，版本号没有增加。"
fi
read -r "?按回车关闭窗口…"
exit $result
