import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as tencentcloud from "tencentcloud-sdk-nodejs";
import { z } from "zod";
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
const server = new Server({
    name: "tencent-cloud-mcp",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// 定义参数 schema
const ListInstancesSchema = z.object({
    limit: z.number().optional().default(10).describe("返回实例数量限制，默认 10"),
});
// 注册 Tools：获取云服务器列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
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
server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Tencent Cloud MCP Server running on stdio");
}
run().catch(console.error);
//# sourceMappingURL=index.js.map