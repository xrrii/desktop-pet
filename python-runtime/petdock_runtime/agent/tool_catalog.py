from __future__ import annotations

"""提供给模型的固定工具目录，不包含任何工具执行逻辑。"""

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "create_artifact",
            "description": "生成一个应用内可预览、由用户决定是否另存的 UTF-8 文本文件。仅在用户明确要求生成文件时调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "建议文件名，不包含目录"},
                    "format": {
                        "type": "string",
                        "enum": ["txt", "md", "json", "jsonl", "yaml", "csv", "tsv", "xml", "html", "css", "js", "ts", "py", "java", "kt", "go", "rs", "sql", "toml", "ini"],
                        "description": "文本文件格式",
                    },
                    "content": {"type": "string", "description": "完整 UTF-8 文件内容"},
                },
                "required": ["filename", "format", "content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "使用已配置的搜索服务查找公开网页。需要最新或外部信息时调用；结果是搜索摘要，读取正文需继续调用 fetch_web_page。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "简洁、具体的搜索关键词"},
                    "maxResults": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 10,
                        "default": 5,
                        "description": "最多返回的结果数",
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_web_page",
            "description": "读取本轮搜索结果或用户本轮明确提供的公开网页正文。只支持普通 HTML 或纯文本页面。",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "要读取的完整 http 或 https URL"}
                },
                "required": ["url"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_url",
            "description": "在系统默认浏览器中打开一个 http 或 https 网页。",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string", "description": "网页地址"}},
                "required": ["url"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_app",
            "description": "打开 PetDock 白名单中的 Windows 应用，可用 ID：notepad、explorer、calculator。",
            "parameters": {
                "type": "object",
                "properties": {"appId": {"type": "string", "description": "应用 ID"}},
                "required": ["appId"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_file_or_folder",
            "description": "使用系统默认程序打开一个已经存在的文件或文件夹。",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "文件或文件夹路径"}},
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remember_preference",
            "description": "保存用户明确表达的长期偏好。仅在用户明确要求记住时调用。",
            "parameters": {
                "type": "object",
                "properties": {"content": {"type": "string", "description": "要记住的偏好"}},
                "required": ["content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forget_memory",
            "description": "删除一条已有的用户长期偏好。",
            "parameters": {
                "type": "object",
                "properties": {"memoryId": {"type": "string", "description": "记忆 ID"}},
                "required": ["memoryId"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_memories",
            "description": "查看当前已经确认的用户长期偏好。",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_skills",
            "description": "按用途搜索已启用 Skill。只返回 Skill 名称和描述，不加载完整指令。",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "任务或能力关键词"}},
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "activate_skill",
            "description": "激活一个已启用 Skill，并只为当前任务加载完整指令。",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string", "description": "Skill 名称"}},
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_skill_resource",
            "description": "按需读取当前激活 Skill 的 references 或 assets 文本资源。",
            "parameters": {
                "type": "object",
                "properties": {
                    "skillName": {"type": "string", "description": "当前 Skill 名称"},
                    "resourcePath": {"type": "string", "description": "Skill 内相对资源路径"},
                },
                "required": ["skillName", "resourcePath"],
                "additionalProperties": False,
            },
        },
    },
]

MEMORY_TOOL_NAMES = {"remember_preference", "forget_memory", "list_memories"}
