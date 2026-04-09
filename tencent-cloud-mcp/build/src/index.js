"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const tencentcloud = __importStar(require("tencentcloud-sdk-nodejs"));
const zod_1 = require("zod");
// 初始化腾讯云 CVM 客户端
const CvmClient = tencentcloud.cvm.v20170312.Client;
const client = new CvmClient({
    credential: {
        secretId: process.env.TENCENTCLOUD_SECRET_ID || "",
        secretKey: process.env.TENCENTCLOUD_SECRET_KEY || "",
    },
    region: process.env.TENCENTCLOUD_REGION || "ap-guangzhou",
    profile: {
        httpProfile: {
            endpoint: "cvm.tencentcloudapi.com",
        },
    },
});
// 初始化 MCP Server
const server = new index_js_1.Server({
    name: "tencent-cloud-mcp",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// 定义参数 schema
const ListInstancesSchema = zod_1.z.object({
    limit: zod_1.z.number().optional().default(10).describe("返回实例数量限制，默认 10"),
});
// 注册 Tools：获取云服务器列表
server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "cvm_list_instances",
                description: "获取腾讯云 CVM 云服务器实例列表及状态信息",
                inputSchema: {
                    type: "object",
                    properties: {
                        limit: { type: "number", description: "返回数量限制，默认 10" },
                    },
                },
            },
        ],
    };
});
// 处理 Tool 调用
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
    if (request.params.name === "cvm_list_instances") {
        try {
            const args = request.params.arguments || {};
            const limit = typeof args.limit === "number" ? args.limit : 10;
            const res = await client.DescribeInstances({ Limit: limit });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(res.InstanceSet, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [{ type: "text", text: `API 请求失败: ${error.message}` }],
                isError: true,
            };
        }
    }
    throw new Error("Tool not found");
});
// 启动标准输入输出传输层
async function run() {
    if (!process.env.TENCENTCLOUD_SECRET_ID || !process.env.TENCENTCLOUD_SECRET_KEY) {
        console.error("Warning: TENCENTCLOUD_SECRET_ID or TENCENTCLOUD_SECRET_KEY is not set.");
    }
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("Tencent Cloud MCP Server running on stdio");
}
run().catch(console.error);
//# sourceMappingURL=index.js.map