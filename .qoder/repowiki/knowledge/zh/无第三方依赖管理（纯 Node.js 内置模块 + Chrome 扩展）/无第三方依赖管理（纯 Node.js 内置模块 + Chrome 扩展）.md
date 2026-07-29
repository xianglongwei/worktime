---
kind: dependency_management
name: 无第三方依赖管理（纯 Node.js 内置模块 + Chrome 扩展）
category: dependency_management
scope:
    - '**'
source_files:
    - extension/manifest.json
    - scripts/capture-attendance.mjs
---

本仓库不包含任何第三方依赖声明文件或包管理器配置，不存在依赖管理系统。

- **Node.js 脚本**（`scripts/*.mjs`）全部仅使用 Node.js 内置模块：`node:fs/promises`、`node:path`、`fetch`、`WebSocket`、`process` 等，通过 `import ... from "node:..."` 直接引入，无需 `package.json`、`go.mod`、`yarn.lock`、`pnpm-lock.yaml` 或 `vendor/` 目录。
- **Chrome 扩展**（`extension/`）采用 Manifest V3，所有逻辑由 `background.js`、`content.js`、`popup.js` 三个原生 JS 文件实现，未引入任何 npm 包；`manifest.json` 中仅声明权限与入口文件，无 `dependencies` 字段。
- 仓库根目录及子目录均未发现 `package.json`、`go.mod`、`Cargo.toml`、`requirements.txt`、`Gemfile`、`composer.json`、`pom.xml`、`build.gradle` 等任一语言生态的依赖清单。

结论：该仓库为“零外部依赖”的工具集，运行环境只需 Node.js（≥20，支持 ESM 与 `node:` 前缀）和已开启 CDP 调试端口的 Chrome 浏览器，不涉及版本锁定、私有源、供应商目录或升级策略等依赖管理实践。