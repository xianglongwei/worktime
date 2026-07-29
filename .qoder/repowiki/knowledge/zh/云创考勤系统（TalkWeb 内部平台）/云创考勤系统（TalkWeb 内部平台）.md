---
kind: external_dependency
name: 云创考勤系统（TalkWeb 内部平台）
slug: yunchuang-talkweb
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

企业内部的考勤管理系统，部署在 `yunchuang.talkweb.com.cn`，基于 JeecgBoot 框架。
- 登录态机制：采用服务端 Redis 存储的滑动过期 token，有活动自动续期，长时间无活动则失效
- 认证方式：支持两种头部格式——`Authorization: Bearer <token>` 或 `X-Access-Token: <token>`，同时需要携带站点 Cookie
- SSO 集成：与公司统一身份认证系统集成，SSO 会话有效期通常长于业务 token（7~30天）
- 考勤接口：`/attendance/human/rzAttendanceinfo/listByMonth`，返回包含日期、工时、异常等信息的记录列表
- 前端架构：JeecgBoot 标准 SPA，登录后将 token 写入 localStorage 的 `pro__ACCESS_TOKEN` 字段