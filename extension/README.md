# 云创考勤洞察

Chrome MV3 插件，用于展示云创考勤日历、月平均工时、欠工时和异常日期。

## 安装试用

1. 打开 Chrome 扩展程序页面：
   `chrome://extensions/`
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录：
   `C:\Users\suerwei\Documents\工时记录\extension`
5. 点击工具栏里的「云创考勤洞察」图标。

## 登录方式

插件不保存账号、密码、Cookie 或 token。

首次使用时，请先在当前 Chrome 用户里正常登录：

`https://yunchuang.talkweb.com.cn/dashboard/analysis`

登录成功后，插件请求考勤接口时会让 Chrome 自动带上该站点已有登录态。如果登录过期，插件会提示打开云创登录页。

## 统计口径

- 非工作日不参与月平均工时。
- 当前日期不参与月平均工时。
- 全日请假不参与月平均工时。
- 半天请假按有效应出勤小时折算分母。
- 实际工时优先采用接口 `duration`。
- 欠工时采用接口 `missDuration`。

月平均工时：

```text
有效应工作小时 = sum(max(workLength - leaveDuration, 0))
有效工作日 = 有效应工作小时 / 8
月平均工时 = sum(duration) / 有效工作日
```
