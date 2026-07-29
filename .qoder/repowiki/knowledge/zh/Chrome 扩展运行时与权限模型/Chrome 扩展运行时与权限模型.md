---
kind: external_dependency
name: Chrome 扩展运行时与权限模型
slug: chrome-extension-api
category: external_dependency
category_hints:
    - client_constraint
scope:
    - '**'
---

本项目为基于 Manifest V3 的 Chrome 扩展，使用 service worker 作为后台脚本。关键约束：
- 通过 `host_permissions` 仅允许访问 `https://yunchuang.talkweb.com.cn/*`，跨域请求受限
- 使用 `chrome.storage.local` 持久化认证快照和考勤数据缓存
- 通过 `scripting` 权限向目标页面注入 content script 收集认证信息
- 通过 `tabs` 权限查询和管理标签页以刷新认证状态
- 所有网络请求必须显式声明 host 匹配模式，不能泛用通配符