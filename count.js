#!/usr/bin/env node
/**
 * count-loc.js
 *
 * 统计指定天数内创建的文件的代码行数（按创建时间）。
 * - 默认递归扫描当前目录。
 * - 可配置文件扩展名、排除目录和行计数模式。
 *
 * 要求: Node.js 16+ (推荐 18+)
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// 默认支持的文件扩展名
const DEFAULT_EXTS = [
    // Web前端
    "js", "ts", "jsx", "tsx", "vue", "html", "htm", "css", "scss", "sass", "less",
    // 后端语言
    "py", "java", "c", "cpp", "cc", "cxx", "h", "hpp", "cs", "go", "rs", "rb", "php", "kt", "swift",
    // 脚本和配置
    "sh", "bat", "ps1",
    // 数据和文档
    "sql", "md", "txt",
    // 移动开发
    "dart", "m", "mm",
    // 函数式语言
    "hs", "ml", "clj", "fs", "elm",
    // 其他语言
    "r", "scala", "pl", "lua", "dockerfile", "makefile", "cmake",
];

const DEFAULT_EXCLUDE_EXTS = [
];
const DEFAULT_EXCLUDES = [
    "node_modules",
    ".git",
    ".idea",
    ".vs",
    "dist",
    "output",
    "dist",
    "dist_electron",
    "dist-electron",
    "dist-vue",
    "release",
    "public",
    "@mediapipe",
    "dev-dist",
    "@vant",
    "tesseract",
    "app-assets",
    "build",
    ".next",
    ".venv",
    "miniprogram_npm",
    "assets",
    ".cache",
    "bak",
    "coverage",
    "Cesium",
    "out",
];

function parseArgs(argv) {
    // 简单的参数解析器: --key value | --flag
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (!next || next.startsWith("--")) {
                args[key] = true; // 布尔标志
            } else {
                args[key] = next;
                i++;
            }
        } else {
            (args._ ??= []).push(a);
        }
    }
    return args;
}

function toList(v, def = []) {
    if (v === undefined) return def.slice();
    if (Array.isArray(v)) return v;
    return String(v)
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function normalizeExt(ext) {
    const e = ext.replace(/^\./, "").toLowerCase();
    return e;
}

function fileHasWantedExt(file, extsSet, excludeExtsSet) {
    const ext = path.extname(file).replace(/^\./, "").toLowerCase();
    // 如果在排除列表中，则不处理
    if (excludeExtsSet.has(ext)) {
        return false;
    }
    // 如果指定了扩展名列表，则必须在列表中
    return extsSet.size === 0 || extsSet.has(ext);
}

function isExcludedDir(dirName, excludeSet) {
    return excludeSet.has(dirName);
}

function daysToMs(days) {
    return Number(days) * 24 * 60 * 60 * 1000;
}

async function* walk(dir, { excludeSet, followSymlinks = false }) {
    let entries;
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
        // 权限或临时错误：跳过
        return;
    }
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            if (isExcludedDir(ent.name, excludeSet)) continue;
            yield* walk(full, { excludeSet, followSymlinks });
        } else if (ent.isSymbolicLink()) {
            if (!followSymlinks) continue;
            let stat;
            try {
                stat = await fsp.stat(full);
            } catch {
                continue;
            }
            if (stat.isDirectory()) {
                yield* walk(full, { excludeSet, followSymlinks });
            } else if (stat.isFile()) {
                yield full;
            }
        } else if (ent.isFile()) {
            yield full;
        }
    }
}

async function statWithFallback(p) {
    // 对符号链接使用 lstat；其他情况使用 stat
    try {
        return await fsp.stat(p, { bigint: false });
    } catch {
        return null;
    }
}

function isOlderThanDays(stat, days, timeField) {
    const now = Date.now();
    const threshold = now - daysToMs(days);

    // 选择时间源:
    // - birthtime: 文件创建时间（在Linux上有时等于ctime）
    // - mtime: 最后修改时间
    // 回退: 如果birthtime不可靠，使用mtime
    let t =
        timeField === "mtime"
            ? stat.mtimeMs
            : Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
                ? stat.birthtimeMs
                : stat.mtimeMs;

    return t >= threshold;
}

async function countFileLines(filePath, { nonemptyOnly = false, maxBytes = 10 * 1024 * 1024 }) {
    // 按大小限制跳过巨大文件（可能是打包文件）；可通过 --max-bytes 配置
    const st = await statWithFallback(filePath);
    if (!st || !st.isFile()) return { lines: 0, nonempty: 0, skipped: true, reason: "非文件" };
    if (st.size > maxBytes) return { lines: 0, nonempty: 0, skipped: true, reason: "文件过大" };

    let text;
    try {
        text = await fsp.readFile(filePath, "utf8");
    } catch {
        return { lines: 0, nonempty: 0, skipped: true, reason: "读取错误" };
    }
    // 规范化行尾并分割
    const lines = text.split(/\r?\n/);
    const nonempty = lines.reduce((acc, l) => (l.trim().length ? acc + 1 : acc), 0);
    return { lines: lines.length, nonempty, skipped: false };
}

function formatNumber(n) {
    return n.toLocaleString();
}

/**
 * 将统计结果保存到文件
 */
async function saveStatsToFile(out, rootDir) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `代码统计结果_${timestamp}.txt`;
    const filePath = path.join(rootDir, fileName);

    let content = `代码统计结果\n`;
    content += `统计时间: ${new Date().toLocaleString('zh-CN')}\n`;
    content += `扫描目录: ${rootDir}\n\n`;

    // 基本统计信息
    content += `=== 基本统计 ===\n`;
    content += `扫描文件数: ${formatNumber(out.scannedFiles)}\n`;
    content += `匹配文件数: ${formatNumber(out.matchedFiles)}\n`;
    if (out.skippedFiles) {
        content += `跳过文件数: ${formatNumber(out.skippedFiles)}\n`;
    }
    content += `总行数: ${formatNumber(out.totalLines)}\n`;
    content += `总非空行数: ${formatNumber(out.totalNonempty)}\n\n`;

    // 文件类型统计
    if (Object.keys(out.fileTypeStats).length > 0) {
        content += `=== 文件类型统计 ===\n`;
        const typeStatsArray = Object.entries(out.fileTypeStats)
            .map(([ext, stats]) => ({ ext, ...stats }))
            .sort((a, b) => b.nonempty - a.nonempty);

        content += `文件类型\t文件数\t总行数\t非空行数\n`;
        content += `-`.repeat(50) + `\n`;

        for (const typeStats of typeStatsArray) {
            content += `${typeStats.ext}\t${typeStats.files}\t${typeStats.lines}\t${typeStats.nonempty}\n`;
        }
        content += `\n`;
    }

    // 配置信息
    content += `=== 配置信息 ===\n`;
    content += `统计天数: ${out.config.days} 天\n`;
    content += `支持扩展名: ${out.config.exts.length > 10 ? out.config.exts.slice(0, 10).join(', ') + '...' : out.config.exts.join(', ')}\n`;
    content += `排除扩展名: ${out.config.excludeExts.length > 10 ? out.config.excludeExts.slice(0, 10).join(', ') + '...' : out.config.excludeExts.join(', ')}\n`;
    content += `排除目录: ${out.config.excludes.slice(0, 10).join(', ')}${out.config.excludes.length > 10 ? '...' : ''}\n`;
    content += `时间字段: ${out.config.timeField}\n`;
    content += `最大文件大小: ${(out.config.maxBytes / 1024 / 1024).toFixed(1)} MB\n`;

    try {
        await fsp.writeFile(filePath, content, 'utf8');
        console.log(`\n统计结果已保存到: ${fileName}`);
    } catch (err) {
        console.error(`保存统计结果失败:`, err.message);
    }
}

async function main() {
    const args = parseArgs(process.argv);

    // 选项配置
    const days = Number(args.days ?? args.d ?? 30);
    if (!Number.isFinite(days) || days < 0) {
        console.error("错误: --days 必须是一个非负数");
        process.exit(1);
    }

    // 帮助信息
    if (args.help || args.h) {
        console.log(`
代码行数统计工具

使用方法: node count.js [options]

参数说明:
  --days, -d <数字>       统计指定天数内创建的文件 (默认: 30)
  --ext, -e <扩展名>      指定文件扩展名，逗号分隔 (默认: 常见代码文件)
  --exclude-ext <扩展名>  排除指定扩展名，逗号分隔 (默认: 二进制和媒体文件)
  --exclude, -x <目录>    排除指定目录，逗号分隔
  --dir <目录>           扫描的根目录 (默认: 当前目录)
  --time <字段>          时间字段: birthtime|创建时间 或 mtime|修改时间 (默认: birthtime)
  --nonempty, --ne       只统计非空行
  --per-file, -p         显示各个文件的详细信息
  --max-bytes <字节数>   最大文件大小限制 (默认: 10MB)
  --help, -h             显示帮助信息

示例:
  node count.js --days 7 --ext js,ts,vue
  node count.js --exclude-ext png,jpg,pdf --per-file
`);
        process.exit(0);
    }

    const exts = toList(args.ext ?? args.e ?? DEFAULT_EXTS).map(normalizeExt);
    const extsSet = new Set(exts);

    // 排除的文件扩展名
    const excludeExts = toList(args['exclude-ext'] ?? args['exclude-exts'] ?? DEFAULT_EXCLUDE_EXTS).map(normalizeExt);
    const excludeExtsSet = new Set(excludeExts);

    const excludes = toList(args.exclude ?? args.x ?? DEFAULT_EXCLUDES);
    const excludeSet = new Set(excludes);

    const rootDir = args.dir ?? process.cwd();

    const timeField = (args.time ?? "birthtime").toLowerCase(); // "birthtime" 创建时间 | "mtime" 修改时间
    const nonemptyOnly = Boolean(args.nonempty || args.ne);
    const perFile = Boolean(args["per-file"] || args.p);
    const followSymlinks = Boolean(args["follow-symlinks"] || args.S);
    const maxBytes =
        args["max-bytes"] !== undefined ? Number(args["max-bytes"]) : 10 * 1024 * 1024; // 10 MB

    const out = {
        scannedFiles: 0,
        matchedFiles: 0,
        skippedFiles: 0,
        skippedReasons: Object.create(null),
        totalLines: 0,
        totalNonempty: 0,
        details: [],
        // 新增：按文件类型统计
        fileTypeStats: Object.create(null),
        config: {
            days,
            exts: [...extsSet],
            excludeExts: [...excludeExtsSet],
            excludes: [...excludeSet],
            timeField,
            nonemptyOnly,
            maxBytes
        },
    };

    for await (const filePath of walk(rootDir, { excludeSet, followSymlinks })) {
        out.scannedFiles++;

        if (!fileHasWantedExt(filePath, extsSet, excludeExtsSet)) continue;

        const st = await statWithFallback(filePath);
        if (!st) {
            out.skippedFiles++;
            out.skippedReasons["状态错误"] = (out.skippedReasons["状态错误"] ?? 0) + 1;
            continue;
        }

        if (!isOlderThanDays(st, days, timeField)) continue;

        const res = await countFileLines(filePath, { nonemptyOnly, maxBytes });
        if (res.skipped) {
            out.skippedFiles++;
            out.skippedReasons[res.reason] = (out.skippedReasons[res.reason] ?? 0) + 1;
            continue;
        }

        // 获取文件扩展名
        const fileExt = path.extname(filePath).replace(/^\./, '').toLowerCase() || '无扩展名';

        console.log("文件： " + filePath + ": " + res.nonempty + " 行 (类型: " + fileExt + ")");

        out.matchedFiles++;
        out.totalLines += res.lines;
        out.totalNonempty += res.nonempty;

        // 按文件类型统计
        if (!out.fileTypeStats[fileExt]) {
            out.fileTypeStats[fileExt] = {
                files: 0,
                lines: 0,
                nonempty: 0
            };
        }
        out.fileTypeStats[fileExt].files++;
        out.fileTypeStats[fileExt].lines += res.lines;
        out.fileTypeStats[fileExt].nonempty += res.nonempty;

        if (perFile) {
            out.details.push({
                file: path.relative(rootDir, filePath) || path.basename(filePath),
                lines: res.lines,
                nonempty: res.nonempty,
                size: st.size,
                birthtime: st.birthtime?.toISOString?.() ?? null,
                mtime: st.mtime?.toISOString?.() ?? null,
            });
        }
    }

    // Output
    if (perFile && out.details.length) {
        // 按非空行数降序，然后按总行数降序
        out.details.sort((a, b) => b.nonempty - a.nonempty || b.lines - a.lines);
        const width = Math.max(...out.details.map((d) => d.file.length), 10);
        console.log("\n文件名".padEnd(width), "总行数".padStart(10), "非空行数".padStart(10));
        console.log("-".repeat(width + 22));
        for (const d of out.details) {
            console.log(d.file.padEnd(width), String(d.lines).padStart(10), String(d.nonempty).padStart(10));
        }
        console.log();
    }

    // 文件类型统计输出
    if (Object.keys(out.fileTypeStats).length > 0) {
        console.log("\n=== 文件类型统计 ===");
        const typeStatsArray = Object.entries(out.fileTypeStats)
            .map(([ext, stats]) => ({ ext, ...stats }))
            .sort((a, b) => b.nonempty - a.nonempty); // 按非空行数降序

        console.log("文件类型".padEnd(12), "文件数".padStart(8), "总行数".padStart(10), "非空行数".padStart(10));
        console.log("-".repeat(40));

        for (const typeStats of typeStatsArray) {
            console.log(
                typeStats.ext.padEnd(12),
                String(typeStats.files).padStart(8),
                String(typeStats.lines).padStart(10),
                String(typeStats.nonempty).padStart(10)
            );
        }
        console.log();
    }

    console.log("配置信息:", out.config);
    console.log("扫描文件数:", formatNumber(out.scannedFiles));
    console.log("匹配文件数:", formatNumber(out.matchedFiles));
    if (out.skippedFiles) {
        console.log("跳过文件数:", formatNumber(out.skippedFiles), out.skippedReasons);
    }
    console.log(
        "总行数:",
        formatNumber(out.totalLines),
        "| 总非空行数:",
        formatNumber(out.totalNonempty)
    );
    if (nonemptyOnly) {
        console.log("(请求的是非空行数；“总行数”仅供参考)");
    }

    // 将统计结果输出到文件
    await saveStatsToFile(out, rootDir);
}

// Run
main().catch((err) => {
    console.error("意外错误:", err);
    process.exit(1);
});
