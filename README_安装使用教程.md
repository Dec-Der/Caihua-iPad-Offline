# V3.1.1：Mac 批量上传后台继续（2026-10-30）

- 修复切换标签页或窗口后只上传一两张就自动暂停的问题；后台继续处理队列，保留手动暂停。
- 批次状态显示待处理数量，区分“尚未完成”和“全部完成”。
- Mac 页面应显示 V3.1.1。刷新后重新选择同一批，点击“开始上传”，已上传文件会按原有规则跳过。请勿关闭、刷新上传中的页面或让 Mac 休眠。

# V3.1：清理已备份图片（2026-10-27）

新增 iPad 顶部「清理已备份图片」，可删除选中的本机照片、标注和同账号云端原图。已有 V3.0 备份分包可用；画笔和 JSON 格式不变。

1. 先把全部标注 ZIP 保存到「文件」App；在 Mac 或其他位置保留原图（JSON ZIP 不含照片）。
2. 点击「清理已备份图片」，选取已保存的 ZIP，可多选分包。程序核对尺寸、状态、修改时间与完整笔画，只列出与备份相符的已完成图片。
3. 勾选图片，确认已核对 ZIP 并保留原图，再点「删除选中 N 张（本机＋云端）」。最后弹窗列出准确文件名，确认后永久删除。
4. 删除时先逐张下载并以 SHA-256 核对同名云端原图；确认云端已不存在后，才用一个 IndexedDB 事务删除本机照片、列表和标注。核对会使用下载流量。若权限拒绝、断网、文件变化，停止批次，保留该张本机数据。已完成的前面图片不会回滚。
5. 云端已删除但本机删除失败时，可用同一备份重新核验后重试；云端缺失也允许完成本机清理。不要同时在其他标签页标注或从 Mac 上传同名文件。
6. 没有实际选择并确认，不会自动删除任何图片。Mac 原文件、已保存 ZIP 和未选中图片保持不变。

首次需在现有 Supabase 项目 SQL Editor 审阅并执行 `enable-own-photo-delete.sql`，增加仅当前登录 UID 目录的 DELETE 策略。该 SQL 本身不删文件、不公开存储桶，不授予跨账号访问；已有 SELECT/INSERT 策略保留。不要用 SQL 直接删除 storage.objects 中的记录。

发布时将本目录的运行文件上传到原 GitHub 仓库根目录，等待 Pages 成功。iPad 联网重新打开，应显示 V3.1 和「清理已备份图片」；不要清除网站数据。

已通过 9 项使用模拟云端和 IndexedDB 的自动测试，覆盖不匹配备份、缺失分包、RLS 静默拒绝、网络中断、同名异内容、账号变化和本机事务回滚。尚未在真实 iPad 或真实云端执行删除验收；先用一张保留原图且已导出备份的完成图片验证。

---

# 彩画裂隙 · Mac / iPad 联动精简版 V3.0

> **定位**：仅提供 ① Mac 上传原照片 → ② iPad 手动同步、Apple Pencil 1–45 px 压感标注 → ③ iPad 导出 JSON ZIP。**不生成 PNG Mask/Overlay，不在 Mac 网页重复保存照片。**
>
> 这是基于现有 GitHub Pages 与 Supabase `caihua-photos` 私有桶的 **代码替换版本**。不需要创建新 GitHub 仓库，不需要新建 Supabase 项目，不需要重新执行已经成功的两条 RLS 策略。代码包中没有你的原始照片、账号、API Key 或数据。

## 1. 当前结构

- Mac 上传入口：`https://dec-der.github.io/Caihua-iPad-Offline/mac.html`
- iPad 标注入口：`https://dec-der.github.io/Caihua-iPad-Offline/`
- 共享服务：现有 Supabase Project URL + publishable key + 已确认用户账号；私有桶名固定为 `caihua-photos`；存储路径 `用户UID/照片名`。
- iPad 本地：同一个 IndexedDB 数据库 `caihua-ipad-offline-v1`，存放已下载照片和 JSON 标注；**手动同步**，不会在画笔过程中后台下载。
- iPad 笔画：**现有 `round-dabs-v2` 不做任何修改**，1–45 原图像素，红色显示，保存 x/y/pressure，分类 class_id=1 (crack)。

## 2. 在 Mac 更新 GitHub Pages（只做一次）

1. 使用 Chrome 打开 `https://github.com/Dec-Der/Caihua-iPad-Offline`，选择 `main` 分支。建议先点 `Code → Download ZIP` 保存当前代码一份，以便需要时回滚（**这只是代码备份，不含 iPad 本地数据**）。
2. 解压 `Caihua_Lean_V3_GitHubPages.zip`。**上传压缩包内部的所有文件**（例如 `index.html`、`mac.html`、`app.js`、`cloud.js`、`cloud-core.js`、`mac-upload.js`、`sw.js`、`jszip.min.js`、图标及授权说明），不要上传 ZIP 文件，也不要多套一层目录。
3. 进入仓库 `Add file → Upload files`，把这些文件放在仓库**根目录**，替换同名文件，最后点 `Commit changes`。
4. 在仓库 `Actions` 中确认 Pages 部署任务是**绿色对勾**。原来的 Pages 配置 `Settings → Pages → main / (root)` 不用更改。
5. Chrome 打开新的 `/mac.html` 页面，应看到“**Mac 原图上传 V3.0**”；iPad 从既有主屏幕图标打开根页面，应看到“**精简版 V3.0 · iPad仅标注 / JSON**”。若未更新，请在联网状态重新打开并等待 service worker 更新；**不要因为看见旧版就删除网站数据**。
6. 保证 Supabase Storage 的 `caihua-photos` 为 Private，原来两条 `insert/select own folder` 策略还有效。公开 GitHub 仓库中只能存代码，不能上传图片、密码、JSON、secret key。

## 3. Mac 上传原照片

1. 打开 `https://dec-der.github.io/Caihua-iPad-Offline/mac.html`。
2. 首次填写 Project URL 与 **Publishable Key**（不是 `sb_secret_`），点“保存连接配置”，输入已确认的 Supabase 邮箱和密码，登录。今后有效会话会自动保留并刷新；无法登录可点“检查云端连通性”。
3. 点击“**选择 Finder 照片（可多选）**”，只选择本批新增的 PNG/JPG/JPEG/WEBP 原图。照片**不缩放、不转码、不改名**。
4. 点击“开始上传”。对**大于6MB**的照片会尝试加载 `tus-js-client` 并使用 Supabase TUS **6MB分块续传**；网络中断后重新选择同一批，再点击上传可以续传。对于小于或等于6MB文件使用普通上传。切换标签页或窗口后会继续上传；后台速度可能降低，上传完成前不要关闭或刷新页面，也不要让 Mac 休眠。
5. 如果 Mac 网络阻止 `cdn.jsdelivr.net`，TUS 组件可能无法加载；页面会明确询问是否改用普通上传大图（可能需要整张重传）。也可以先更换可正常访问该脚本的网络/内容拦截设置再尝试。
6. 页面显示“新上传 X 张｜已存在 X 张｜失败 X 张”后，点击“**读取云端照片清单**”确认数量。下次批次只选新照片即可，不需要从 A_0001 重头导入。
7. **云端已有同名照片**默认跳过；若同名文件大小不同则终止。对于同名同大小但不同内容，当前版本**不能仅靠清单证明相同**，所以你的 `A_0001.png` 等名称必须在整个批次中唯一、不可重复指代另一张照片。保持 Mac 原始文件备份。

注意：TUS 是 Supabase 官方推荐的大文件传输方案；分块上传地址在服务器的可续传有效期有限，并非无限期断点续传。Supabase 免费项目的存储额度/单文件限制必须在 Dashboard 的 Usage、Storage 中核实。**出现 `EXCEEDING USAGE LIMITS` 时，必须先处理云端限额，网页代码无法绕过。**

## 4. iPad 同步原图与压感绘制

1. iPad 联网，从原来安装好的主屏幕图标打开标注页；首次需要配置相同的 Project URL、Publishable Key、**同一个 Supabase 用户账号**。不同 Wi-Fi 没关系；Mac 可以关机。
2. 点击“**同步云端照片**”，程序读当前 UID 的云文件列表，**逐张下载到 iPad 本地数据库**；下载成功的文件不会再重复下载。下载中途网络中断可重新点击继续，已保存的照片继续保留。
3. 左侧“图片列表”选择照片。Apple Pencil 仍使用**相同的1–45像素平滑压感**、红色裂隙，手指平移/双指缩放，笔迹抬笔后自动保存。
4. **下载完成后可以断网绘制**，断网期间不能获取云端新照片。同步与绘制不能同时进行；升级版不在后台自动同步，减少 iPad 高分辨率照片与绘制争用内存。
5. 如果 iPad 本地存储已经紧张，建议一次同步 10–20 张后完成这些照片；V3.1 可使用上面的「清理已备份图片」逐批释放空间。关闭应用不会主动释放已下载照片占用的设备存储。

## 5. iPad 导出 JSON（唯一标注成果）

1. 每笔结束、页面显示“**笔画已持久保存到 iPad**”后，点击“**生成 JSON 备份 ZIP**”。
2. 程序逐张读取已完成的标注，不生成 PNG，不处理原图。**每包最多10张**，防止一个大 JSON ZIP 占用太多 Safari 内存。
3. 点击“**保存 / 分享备份**”，选择“存储到文件 → iCloud Drive”，在“文件”App确认 ZIP 真正存在。
4. 返回应用点“**确认已保存→下一包**”，直到全部完成。文件名类似 `caihua_JSON_Sxxxx_part_001_of_009.zip`。必须收齐所有分包；每包有相同的全照片清单、完成状态及批次校验标识。
5. ZIP 的 `annotations/A_0001.json` 保留：原照片尺寸 `width/height`、`image_id`、`crack` class_id=1、每一笔的 `x/y/pressure` 点列和 `renderer=round-dabs-v2`。没有画完的照片不伪造 JSON；明确确认无裂隙者记录在 manifest 状态中。

## 6. 在 Mac 核验和汇总 JSON（不会制作 PNG）

1. iPad 上所有 ZIP 通过 iCloud Drive 传回 Mac，放进**同一个空文件夹**，如 `~/Downloads/CaihuaJSON`。不要混入其他时间或不同批次的 ZIP。
2. 解压完整包中的 `Mac_Tools/verify_and_collect_json.py`。使用系统 Python3 执行：

```bash
python3 "$HOME/Downloads/Caihua_Lean_V3/Mac_Tools/verify_and_collect_json.py" \\
  --backups "$HOME/Downloads/CaihuaJSON" \\
  --output "$HOME/Desktop/CaihuaJSON_Collected"
```

3. 程序逐包核对 ZIP CRC、`stamp`、分包总数、JSON/照片名称与尺寸、pressure 有效性，**缺少任何一包就拒绝声称导出完成**。
4. 输出仅包含 `annotations/*.json`、`dataset_manifest.csv`、`validation_summary.json`。**不改变压感数据，不生成 Mask 或 Overlay**。后续研究准备阶段再使用单独的 Mac 转换程序。

## 7. 必须实际验收的四组测试

- **登录**：Mac 登录成功；iPad Safari 和主屏幕入口都能登录；关闭重开后会话仍有效。
- **原图一致性**：先上传5张不同尺寸/格式原图，iPad 同步后核对文件名、宽高；断网重新打开仍可显示。
- **笔画稳定性**：每张画5笔不同压感粗细，保存、切图、关闭重进，笔画完整且仍是红色；手指移动不生成笔画。
- **JSON完整性**：完成5张、导出 ZIP、Mac 核验工具显示数量和状态准确。再测试网络中断恢复及 20–50 张批量同步。

只有上述测试在**你的真实 iPad、Mac 和 Supabase 项目**通过后，再正式一次同步100多张。当前已完成静态代码检查、云请求模拟和 JSON 分包核验测试；**没有在你的真实 Supabase 账号、Safari 和 iPad 设备上进行过端到端实机验收，也不承诺任何网络环境下零故障**。

## 8. 常见错误

- **Load failed**：先测试 iPad Safari 能否访问 Supabase `/auth/v1/health`，再看平台“诊断连接”及 Supabase Auth/API Gateway 日志；这是网络连接问题，不要重复创建账号。
- **Invalid login credentials**：确认 Mac/iPad 使用同一套邮箱密码与 Project URL/Publishable Key；Mac/ iPad 不要自动填充旧密码。不要混用数据库密码。
- **上传失败或慢**：检查 Supabase Usage/Storage 限额、Mac 网络、超6MB是否使用TUS、是否加载了 JSDelivr 的 TUS 脚本；不会改变原图来“提速”。
- **iPad `database connection is closing`**：页面改为在创建新事务失败时尝试重新连接，但不能保证设备内存不足或 Safari 强行关闭后台时无异常；勿同时开两个标注标签。
- **旧照片仍在 iPad**：iPad IndexedDB 和云桶是两份独立数据；本版本云同步是仅新增；V3.1 通过单独的已备份图片清理入口手动删除，避免云端误操作删除本地 JSON。
