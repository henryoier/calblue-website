# CalBlue 网站：Henry / Agent 交接

更新日期：2026-10-21（America/New_York）。接手仓库：<https://github.com/henryoier/calblue-website>。

**继续沿用现有 Supabase 会员系统。完成 Google 登录、球员资料与账单、管理员全队管理，以及球员一键申报付款。GitHub 存代码；线上业务数据存现有数据库。本地加密管理台保留为可选工具。**

本文件中的“最新确认要求”优先于仓库中较早的产品说明。不要把本地代码、演示画面或测试通过当作已经上线。本分支没有真实球员数据、数据库密码、OAuth secret 或 Henry 的可用登录凭据。

## 1. 最新确认要求

### 账户与权限

| 身份 | 应有权限 |
| --- | --- |
| 未登录访客 | 看公开球队和球员页面，包括公开球员的生日、普通球员照片；不能看账单、私人联系方式、医疗信息或证件照片 |
| 球员 | 用 Google 登录；查看自己的资料和账单；一键申报“我已付款”，也能撤回误报；不能直接修改应付金额或把账单结清 |
| 管理员 | 看全队全部资料，包括生日、头像、联系方式、医疗信息，以及将来若收集的私密证件照片；管理账单、审核付款申报、登记到账、导出资料和处理催缴 |
| Henry 的 agent | 与 Gary / Henry 相同的管理员业务权限：查看所有已收集资料、管理账单、核对并登记到账；使用独立可识别的管理员 Auth 身份，保留审计和会计校验 |

**最终权限修正：Henry 和他的 agent 都是管理员，不采用之前的只读限制。** 旧只读数据库脚本仅保留作历史参考，不能拿它开通本次要求的账号。管理员能够查看所有已收集资料，包含生日、头像、医疗信息和私密证件照片。

用户确认允许公开球员页展示生日与普通球员照片；**身份证、驾照、护照等证件照片不公开**。公开展示范围与管理员查看范围分开。

第一位管理员邮箱已由用户私下确认，不在公开仓库重复发布。Henry 本人及其 agent 均按用户最新指示授予与 Gary 相同的 `admin` 业务权限；实际登录邮箱／Auth UUID 需要 owner 核实。不要仅凭浏览器传来的 email 或可编辑 user_metadata 判断管理员。

### 收款信息

- 银行：Chase。
- 当前只需 Zelle。Tag：`gocalblue1996`。
- 收款人必须显示：`CALBLUE CHINESE COMMUNITY`。
- Venmo 暂不配置；不要把未配置入口展示给球员。
- 球员在自己的银行／Zelle 中转账。网站的“我已付款”按钮只做申报，不发起转账、不证明到账。
- 尚无 Chase 实时接口、银行授权或自动到账验证。先支持管理员核对实际银行记录，未来再接只读银行同步。

### 球员编号与资料

球员编号是球队自定义编号，不是政府证件号。本地版本已实现 `CB-加入年份-序号`；线上当前使用 UUID，仍需增加稳定的球队编号及加入年份，处理序号并发和不重复使用。不要用姓名自动合并、关联账号或迁移历史账单。

收集基本联系信息、DOB、普通正面球员照片等。公开生日和球员照片是已确认产品方向；注册页标清哪些字段会展示在公开页。沿用现有 `is_public` / 球员审核的发布流程，历史资料不要不加区分地整体复制到公共 JSON。

头像／球员肖像与证件照片必须是不同字段和不同存储路径。当前本地注册不收政府证件照；“不公开”不是新增必交证件的要求。未来若收集，放私有存储，通过管理员授权获取短期访问地址，不能塞进公开头像 URL、公开 roster 或静态部署文件。

## 2. 球员付款：目标交互

以登录后的“我的账单”为主，不再要求普通线上球员下载付款文件再发给管理员。

1. 未付时展示应付金额、Zelle tag 和收款人，提供 **我已付款** 按钮。
2. 点一次即保存申报，自动关联当前登录账户、当前账单／应付余额快照、金额和申报时间，不强制再填流水号或上传截图。可提供“金额不同／补充说明”的次要入口。
3. 界面变为 **已申报，待管理员核对**，提供 **撤回申报／我还没付**。重复点击、刷新或网络重试不能生成多份申报。
4. 管理员在待核对队列看到账户、申报金额和时间，核对实际银行入账后点 **确认到账**，也可驳回并填写原因。
5. 确认到账后记入实际收款，刷新余额。球员不能把已确认的收款切回未付；退款和纠错由管理员处理。

球员申报状态与会计状态分开：`未申报 → 待核对 → 已确认／已驳回`，未确认前可撤回。已有部分付款时继续显示实际剩余金额。待核对状态不能提前减少余额，也不要继续发送要求重复付款的催缴文案。

**建议实现边界（尚未完成）：**

- 新增 `payment_reports` 或等价模型，至少含 account_id、账单／周期关联或余额快照、申报金额、状态、created_at、reviewed_by、reviewed_at、关联 payment_id、幂等请求标识。用明确约束避免同一结算对象出现多个有效待核对申报。
- 若按账户余额而非单项收费申报，要明确申报时的快照和以后新增费用的区别；现有在线付款按账户记账，尚无逐项收费的完整分摊关系。不能把账户余额直接当作每张单项账单的未付金额。
- 球员写入由服务端身份派生 account_id；只准申报／撤回自己的未确认记录。管理员确认和记账必须在同一个数据库事务中完成，并支持幂等重试。
- 两个管理员同时确认同一申报只能产生一次收款；银行交易的重复录入要有独立检查。现有表单重试 UUID 只避免同一请求重试，不能防止两个新请求重复录入同一银行流水。
- 管理员“修改账单”应延续现有不可变流水设计：未结算收费可作废重开，已记收款通过冲正／退款纠正，保留审计；不要绕过数据库触发器覆盖历史金额。

## 3. 这次已做好的代码更新

完整代码更新随本分支提交，不需要再获取本地附件。基于提交：

```text
7a7630bb3a3d21f4374536f50e01e61a65d73e7b
```

发布分支为 `zizhou-gary-liu/calblue-website:codex/member-management-handoff`，向原仓库 `main` 提交 PR。原仓库不允许当前 GitHub 账号直接 push，因此使用 fork / PR 交付。主分支合并与生产部署尚未完成。在线账户／账单扩展已经恢复到统一交付中，不需要寻找之前的 deferred 草稿或叠加旧分包 patch。

| 模块 | 已实现 | 关键位置 |
| --- | --- | --- |
| 在线登录与角色界面 | 在现有邮箱登录上增加 Google PKCE 流程；登录状态变化、注销和权限变化清空私密界面；Google 开关仍关闭 | `app/js/auth.js`、`app/config.js`、`app/views/sign-in.js`、`app/js/app.js` |
| 在线球员账单 | `#/billing` 查看自己的余额和流水、展示已确认的 Zelle 信息；账户过滤和异常响应检查 | `app/js/billing.js`、`app/views/billing.js` |
| 在线管理员账务 | `#/admin/payments` 分页查看全队账户、余额、关联球员；新增收费、人工核对后录入 Zelle 收款；同请求重试幂等 | 同上；说明见 `app/accounts-and-billing.md` |
| 本地加密管理台 | 整库加密、登记资料、头像处理、稳定球队 ID、收费、部分付款、银行文件导入和核对、导出、提醒草稿、备份恢复 | `club-office/`、`scripts/start_club_office.py` |
| 本地注册／付款文件 | `.cbreg` / `.cbpay` 加密导入；这是可选离线流程，不是目标线上一键交互 | `club-office/register.*`、`club-office/pay.*` |
| 提醒发送辅助 | 默认 dry-run，显式发送模式和发送记录；未配置实际发送账号、未发送真实邮件 | `scripts/send_club_reminders.py` |
| Henry / agent 管理员授权 | 对已验证 Auth 账户授予／撤销 admin 的 owner 脚本和凭据说明；旧只读方案明确标为历史参考 | `supabase/agent-access/` |
| 配套检查 | 本地加密与账务、线上账户隔离与 Google 流程测试；CI 增加相应 Node 测试 | `tests/club-office/`、`tests/member-app/`、`app/tests/` |

线上业务数据与本地 vault **没有自动同步**。把在线数据库作为会员入口的主数据源；本地加密工具可作为辅助归档，不要求球员先建本地 vault。若要迁移已有本地资料，单独做映射、去重和核对，不直接覆盖线上 UUID 或历史付款归属。

## 4. 还没做好的内容：接手优先级

1. **线上一键付款申报及管理员审核闭环**：本次新确认的交互和数据库模型尚未实现。当前线上代码只显示付款说明并让球员联系管理员；不要误报为已有按钮。
2. **公开 DOB 与照片分离**：现有公共 roster 投影不返回 DOB；普通头像已有公开照片路径，但线上个人资料编辑／上传尚未形成完整流程。实现 public profile 的最小字段投影、上传与展示；证件私密区若需要再单独做。
3. **管理员完整资料管理**：目前有身份审核和账务界面，账务页显示部分关联球员信息；尚未形成涵盖全部联系方式、照片、医疗资料等的统一管理界面。完成全资料查看及所需编辑／导出，不让前端隐藏代替数据库权限。
4. **Google 与第一位管理员**：配置现有 Google provider、精确回调地址、管理员角色，跑两个真实测试账号的权限验证。
5. **Henry agent 开通**：核实 Henry 和独立 agent 的已验证 Auth 账户，授予 admin，验证完整管理权限、会计约束、审计及撤销；未生成可用线上凭据。
6. **线上球队 ID、表单生成和数据迁移**：按用户加入年份分配 ID；现有本地 CSV 导出不等于任意联赛表格自动填好。接到真实模板后再做字段映射与生成，保留 league ID 和 club ID 的区别。
7. **提醒和银行对接**：先上线人工核对与提醒预览；待有发送账户和银行授权，再做真实发送／只读银行接入。不要宣称已接 Chase 或自动验证 Zelle。

## 5. 沿用的设施与上线配置

现有仓库：公开网站由 GitHub Pages 工作流发布，域名配置为 `calbluefc.com`；会员应用代码位于 `/app/`。独立会员域名 `app.calbluefc.com` 是既有设计／配置目标，本次没有验证其生产部署已完成。

既有 Supabase 项目：`https://rmksoklavpoartewjvus.supabase.co`，项目 ref `rmksoklavpoartewjvus`。`app/config.js` 中是可公开 publishable key，不是数据库管理员密钥。此前本次会话只读检查确认邮箱登录开启、Google 关闭；上线时重新检查当前配置。

保留无构建依赖的 ES modules 约定，不引入 package.json、bundler、node_modules。遵循现有 `docs/design/adr/0001-client-stack.md`；SQL 的来源是 `docs/design/schema.sql`，通过 `scripts/build_migrations.py` 生成迁移并同步检查。新功能要增加新迁移，不重跑已发布的 0001–0004。

配置顺序：

1. 项目 owner 检查现有迁移、Auth、RLS、存储与应用域名；本地权限测试不能证明线上已配置。
2. 在 Google Cloud / Supabase 配置 Google 登录。OAuth client secret 只放服务端 provider 配置；回调采用 Supabase 面板显示的值，当前预期为 `https://rmksoklavpoartewjvus.supabase.co/auth/v1/callback`。验证 app 的精确 redirect allow-list 后再打开 `GOOGLE_AUTH_ENABLED`。
3. Gary、Henry 和独立 agent 账户应先完成身份核实。使用 `supabase/agent-access/grant-admin.sql`，以确切的已验证 Auth UUID 授予 admin。脚本不创建用户、不向未来同邮箱注册预先授予权限。授权后刷新会话。
4. 按 `supabase/agent-access/README.md` 为 Henry 的 agent 配置独立管理员 Auth 凭据，通过用户 access token / refresh token 使用现有数据 API。管理员业务权限不需要 Supabase secret key、service_role key 或 postgres 管理员密码。
5. 发布程序和迁移，验证普通球员、另一位球员、人类管理员和管理员 agent 四种身份的访问边界，再用真实的授权测试账户检查登录、页面、数据和撤销。

后台权限、数据库连接、Google secret、邮件凭据不要放进前端或本交接包。管理员权限不等于已拿到 Chase 授权。现有 JWT 中角色可能保留至刷新／过期，紧急撤销按项目会话策略处理，不宣称所有已签发 JWT 即时失效。

## 6. Henry / agent 管理员访问

**与 Gary 相同的管理员业务权限。** Henry 用自己的 Google／邮箱账户；agent 使用独立、可识别的 Auth 账户并获得相同 `admin` 角色。这样其管理操作可记录为该 agent 的身份，而不是冒用 Gary 的会话。

`supabase/agent-access/grant-admin.sql` 要求 owner 在同一会话先设置确切 `calblue.target_account_id`，检查邮箱已验证、Auth/profile 匹配，并保留其他角色。按需要分别对 Henry 和 agent 执行。不要填写虚构邮箱或直接修改前端把 agent 标成 admin。

agent 可以管理账单、核对银行依据后登记收款、查看全部资料。保留幂等、审计、封账和流水纠错规则。该身份本身不会创建 GitHub 写权限、发信账户或 Chase 授权；这些渠道仍需分别配置。付款申报不能作为到账证据。

`revoke-admin.sql` 移除指定账户的 admin 角色；owner 还需撤销／刷新 Auth 会话。已签发 JWT 可能保留旧角色至过期，脚本不宣称即时撤销。凭据放 agent 的秘密存储，不提交 GitHub。

历史 `provision.sql` / `revoke.sql` / `test.sql` 属于被替代的只读 PostgreSQL 方案：本地验证过，但从未用于生产，不是本次应执行的开通脚本。

## 7. 验证记录与下一步验收

合并交接代码后本次重新运行：

- Node 新增测试：**39/39**（本地管理台 28、在线账户／Google 11）。
- Python 测试：**301/301**。
- 既有 JS 逻辑：**85/85**；异步会话逻辑：**135/135**。
- no-build、secret scan、SQL 结构、4 份迁移同步、seed 结构、网站引用检查和 staged diff 空白检查通过。
- 本次新增 admin 授权／撤销脚本已在本地 PostgreSQL 验证：拒绝缺失目标、未验证邮箱、非 owner 和邮箱不一致；授予精确账户、重复执行不重复角色、保留其他角色／metadata、同步 Auth claim、撤销仅移除 admin。
- 此前在线草稿浏览器测试：**304/304**；此次恢复交接代码后未重复跑浏览器 DOM 测试，部署前需重跑。
- 历史只读 Agent SQL 在一次性本地 PostgreSQL 17 上执行现有四份迁移和开通脚本后，用虚构数据验证读取、退款／作废账单、字段排除、写入／提权拒绝、普通会员隔离和撤销。另以独立连接验证受限账号及禁用后无法登录。该环境模拟了 Supabase Auth 函数，不是线上 Supabase 验收。

接手前先检查工作区，保留已有修改。在独立分支检出这个 PR 后执行：

```sh
python3 -m unittest discover -s tests
python3 scripts/run_js_tests.py
python3 scripts/run_async_js_tests.py
node --test tests/club-office/*.test.mjs tests/member-app/*.test.mjs
python3 scripts/check_no_build.py
python3 scripts/check_secrets.py
python3 scripts/check_sql.py
python3 scripts/build_migrations.py --check
python3 scripts/check_seed.py
python3 scripts/check_site.py
python3 scripts/start_member_app.py
```

使用 Node 22+。最后打开 `http://localhost:8080/app/tests/` 做浏览器测试；`app/tests/billing-preview.html` 是虚构数据预览，不代表真实登录或数据库连接。若 Henry 的当前分支已前进，先在独立分支审查、解决冲突；不要 reset 掉其现有工作。本 PR 已包含累积代码，不能再叠加旧的分包 patch。

新增验收至少覆盖：A 球员不能读／申报 B 的账单；一键申报重试不重复；待核对不结清；撤回不删除已确认收款；管理员双击／并发确认只记一次；待核对提醒不要求重复付款；公开 DOB／头像正常而证件照片和医疗信息无法匿名获取；管理员完整查看；管理员 agent 能执行合法管理操作并留下其身份审计，但仍不能绕过会计约束；普通球员继续不能管理全队账务。

## 8. 交接完成时请回报

回报后续改动 commit / PR、实际部署地址、执行过的迁移、四种身份的实测结果、Google / 邮件 / 银行哪些已配置哪些未配置。明确区分“代码完成”“已部署”“真实账户验证完成”，不要用测试截图代替上线结论。

到本交接为止：**未改动生产数据库、未上传真实球员资料、未授予线上管理员／agent 权限、未发送真实提醒邮件、未连接银行。**
