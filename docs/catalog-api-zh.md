# 只读目录 API 使用说明

本文档介绍 CloudFlare-ImgBed 的只读目录 API，该 API 专为 AI 客户端和第三方应用程序设计，可安全地发现、列出和搜索图床中的图片。

## 功能特性

- ✅ Bearer Token 认证，使用专用 `catalog` 权限
- ✅ 分页查询，支持搜索和目录筛选
- ✅ 返回公共访问 URL（非内部存储地址）
- ✅ 仅暴露安全元数据（名称、路径、大小、类型、标签）
- ✅ 自动过滤屏蔽/成人/已删除内容
- ✅ 拒绝所有修改操作（只读）
- 🔒 永不暴露：Telegram file_id/token、存储凭据、内部配置

## 生产部署配置步骤

### 1. 创建专用 Catalog Token

在 Cloudflare Pages 项目的**环境变量**中，不直接存储 token 值。Token 由系统生成并存储在 D1 数据库的安全配置中。

**通过管理后台创建 Token：**

1. 登录图床管理后台
2. 进入 **系统设置** → **安全设置** → **API Token**
3. 点击 **创建 Token**
4. 设置：
   - 名称：`AI Catalog Reader`（或其他描述性名称）
   - 权限：勾选 `catalog`（**仅此一项**，不要勾选 upload/delete/manage）
   - 有效期：根据需要设置，建议设置合理的过期时间
5. 保存后，系统会显示生成的 Token（格式：`imgbed_xxxx...`）
6. **安全保存此 Token**，页面关闭后无法再次查看完整值

> ⚠️ **重要安全提示**：
> - 请勿将 Token 提交到代码仓库
> - 请勿在日志、聊天或公开渠道中输出 Token
> - 建议为每个 AI 客户端创建独立的 Token，便于管理和撤销

### 2. 配置客户端

将 Token 配置到 AI 客户端的环境变量或安全配置中：

```bash
# 示例：环境变量配置
export IMGBED_CATALOG_TOKEN="imgbed_your_token_here"
```

## API 端点

### 列出文件

```
GET /api/catalog/list
```

**请求头：**
```
Authorization: Bearer <your_catalog_token>
```

**查询参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dir` | string | `""` | 目录路径，如 `photos/2024/` |
| `search` | string | `""` | 搜索关键字（匹配文件名） |
| `type` | string | `""` | 文件类型：`image`、`video`、`audio`、`other` |
| `start` | number | `0` | 分页起始位置 |
| `count` | number | `50` | 返回数量（最大 200） |
| `recursive` | boolean | `false` | 是否递归包含子目录文件 |

**响应示例：**

```json
{
  "files": [
    {
      "name": "sunset.jpg",
      "path": "photos/2024/sunset.jpg",
      "url": "https://your-imgbed.pages.dev/file/photos%2F2024%2Fsunset.jpg",
      "type": "image/jpeg",
      "size": 2.5,
      "timestamp": 1700000000000,
      "tags": ["nature", "landscape"],
      "directory": "photos/2024/"
    }
  ],
  "directories": ["photos/2024/spring/", "photos/2024/summer/"],
  "totalCount": 150,
  "returnedCount": 50,
  "hasMore": true,
  "directory": "photos/2024/"
}
```

**返回字段说明：**

| 字段 | 说明 |
|------|------|
| `name` | 文件名 |
| `path` | 文件完整路径（用于内部引用） |
| `url` | 公共访问 URL（可直接用于 `<img src>` 等） |
| `type` | MIME 类型 |
| `size` | 文件大小（MB） |
| `timestamp` | 上传时间戳（毫秒） |
| `tags` | 标签数组（如果有） |
| `directory` | 所在目录 |

## 使用示例

### cURL 示例

```bash
# 列出根目录下的图片
curl -H "Authorization: Bearer imgbed_your_token" \
  "https://your-imgbed.pages.dev/api/catalog/list?type=image&count=20"

# 搜索包含 "cat" 的文件
curl -H "Authorization: Bearer imgbed_your_token" \
  "https://your-imgbed.pages.dev/api/catalog/list?search=cat"

# 列出特定目录
curl -H "Authorization: Bearer imgbed_your_token" \
  "https://your-imgbed.pages.dev/api/catalog/list?dir=photos/pets/"
```

### Python 示例

```python
import requests
import os

IMGBED_URL = "https://your-imgbed.pages.dev"
CATALOG_TOKEN = os.environ.get("IMGBED_CATALOG_TOKEN")

def list_images(directory="", search="", page=0, per_page=50):
    headers = {"Authorization": f"Bearer {CATALOG_TOKEN}"}
    params = {
        "dir": directory,
        "search": search,
        "type": "image",
        "start": page * per_page,
        "count": per_page,
    }
    response = requests.get(f"{IMGBED_URL}/api/catalog/list", headers=headers, params=params)
    response.raise_for_status()
    return response.json()

# 使用示例
result = list_images(search="landscape")
for file in result["files"]:
    print(f"{file['name']}: {file['url']}")
```

### JavaScript/Node.js 示例

```javascript
const IMGBED_URL = "https://your-imgbed.pages.dev";
const CATALOG_TOKEN = process.env.IMGBED_CATALOG_TOKEN;

async function listImages({ directory = "", search = "", page = 0, perPage = 50 } = {}) {
  const params = new URLSearchParams({
    dir: directory,
    search,
    type: "image",
    start: page * perPage,
    count: perPage,
  });
  
  const response = await fetch(`${IMGBED_URL}/api/catalog/list?${params}`, {
    headers: { Authorization: `Bearer ${CATALOG_TOKEN}` },
  });
  
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// 使用示例
const result = await listImages({ search: "sunset" });
result.files.forEach(file => console.log(`${file.name}: ${file.url}`));
```

## 错误响应

| HTTP 状态码 | 说明 |
|-------------|------|
| `401` | 未授权：缺少 Token、Token 无效或已过期、Token 缺少 `catalog` 权限 |
| `405` | 方法不允许：尝试使用 POST/PUT/DELETE 等修改方法 |
| `500` | 服务器内部错误 |

**错误响应格式：**

```json
{
  "error": "错误描述信息"
}
```

## 安全说明

1. **权限隔离**：`catalog` 权限与 `upload`/`delete`/`manage` 完全独立，即使 Token 泄露也无法修改数据
2. **内容过滤**：API 自动过滤已屏蔽、成人内容和已删除的文件
3. **元数据安全**：响应中不包含任何敏感信息（存储凭据、内部 ID、配置等）
4. **URL 安全**：返回的 URL 是通过应用公共路由访问的，非直接存储地址

## 限制

- 单次请求最多返回 200 条记录
- 建议使用分页遍历大量数据
- Token 应妥善保管，定期轮换
