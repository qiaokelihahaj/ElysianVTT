import { ActionTemplate } from '@hard-vtt/shared';
/**
 * 模拟内存数据库/JSON加载器
 * 在正式环境中，这会在服务器启动时从 Prisma(SQLite) 或 JSON 文件中加载
 */
export declare class Dictionary {
    private static actions;
    static loadAllFromDb(): Promise<void>;
    static getAction(id: string): ActionTemplate | undefined;
}
//# sourceMappingURL=Dictionary.d.ts.map