/**
 * ponytail-always: 仅当本轮任务是代码相关任务（编写、新增、重构、修复、审查、
 * 设计代码，以及选库/选依赖）时，把 ponytail 技能全文注入 system prompt。
 *
 * 分类逻辑（本地关键词启发式，零额外 LLM 调用）：
 *   1. 命中显式触发词（ponytail / be lazy / yagni / over-engineering…）→ 注入
 *   2. 当前消息是文档写作任务（PRD/SDD/需求文档/设计文档…）→ 跳过，明确不纳入
 *   3. 当前消息命中强非代码信号且无代码信号（翻译/菜谱/诗歌/小说/简历…）→ 跳过
 *   4. 当前消息命中代码信号 → 注入
 *   5. 无信号（如“继续”“然后呢”“好的”）→ 回看当前分支最近几条用户消息，
 *      有代码信号 → 注入（承接多轮编码会话）
 *   6. 全部无信号 → 跳过（默认不注入，符合“仅代码任务注入”）
 *
 * 机制：before_agent_start 每轮触发一次，返回修改后的 systemPrompt。
 * 系统提示按轮重建、回合内保持不变，因此注入一次即覆盖整轮全部 LLM 调用，
 * 不存在累积/重复问题，也不写入会话文件。
 *
 * 成本：ponytail SKILL.md 约 6.7KB（≈2K tokens/轮，仅代码相关轮次）。
 * 已知上限：关键词启发式区分“编程知识问答 vs 编码任务”的边界有限（如
 * “Python 的 GIL 是什么”会误注入）；需要更准的语义分类时，升级路径是加一次
 * 轻量分类模型调用。撤销：删除本文件后 /reload（或新开会话）即可。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SKILL_PATH = join(homedir(), ".pi", "agent", "skills", "ponytail", "SKILL.md");

// 显式触发词（技能 description 中的触发词，含中文惯用说法）
const TRIGGER_RE =
	/ponytail|be lazy|lazy mode|simplest solution|minimal solution|yagni|do less|shortest path|over.?engin|bloat|boilerplate|unnecessary dependen|过度设计|偷懒模式|最简方案/i;

// 文档写作任务：PRD/SDD 及各类设计/需求文档明确不纳入（优先级高于代码信号，
// 也堵住“先写代码再写文档”的历史承接误注入；显式触发词仍优先于本清单）
const DOC_RE =
	/PRD|SDD|需求文档|产品需求|需求规格|需求说明|写需求|需求编写|设计文档|系统设计|架构设计|概要设计|详细设计|技术设计|接口文档|用户手册|帮助文档|使用文档/i;

// 强非代码信号：当前消息命中且无代码信号时才跳过（两者并存时代码优先）
const NON_CODE_RE =
	/翻译|translate|translation|菜谱|食谱|recipe|做饭|做菜|烘焙|写诗|诗歌|作诗|诗句|小说|故事|story|essay|读后感|观后感|影评|书评|情书|写封信|写一封信|letter|天气|weather|健身|锻炼|workout|减肥|旅游|travel|歌词|lyrics|笑话|joke|谜语|riddle|演讲稿|简历|resume|cv|自我介绍|祝福|贺卡|情话|文案|读书笔记|新闻|星座|占卜|算命|股票|基金|理财/i;

// 代码信号：任务动词 + 代码名词 + 语言/技术名（短英文词加 \b 防子串误报）
const CODE_RE =
	/\bcode\b|codebase|coding|program|script|function|\bclass\b|module|component|interface|\bapi\b|endpoint|variable|\btype\b|database|schema|\bsql\b|query|algorithm|regex|refactor|implement|debug|\bfix\b|\bbug\b|error|exception|crash|\btest\b|library|package|dependenc|framework|architecture|deploy|commit|branch|merge|diff|build|compile|lint|\bcli\b|server|backend|frontend|async|thread|performance|optimiz|review|migrat|python|javascript|typescript|java|react|vue|node|\brust\b|golang|flutter|swift|kotlin|c\+\+|\bhtml\b|\bcss\b|bash|shell|代码|编码|编程|程序|函数|类|模块|组件|脚本|接口|变量|类型|数据库|算法|正则|重构|实现|开发|修复|报错|异常|崩溃|依赖|框架|架构|部署|提交|分支|合并|构建|编译|审查|调试|性能|优化|服务端|前端|后端|命令行|多线程|并发|打包|迁移|升级|技术栈|设计模式|单元测试|自动化|爬虫|生成器|工具|网站|网页|页面|app|应用|小程序|界面|landing|项目|工程|仓库|repository|写代码|写函数|写脚本|写个类|写程序|写个测试|写测试|加个测试|加个功能|加个接口|加个字段|实现功能|修复问题/i;

/** 从当前分支最近的会话条目中提取用户消息文本（最近的在最前，最多 limit 条） */
function recentUserTexts(session: { getBranch(): unknown[] }, limit = 6): string[] {
	let entries: unknown[] = [];
	try {
		entries = session.getBranch(); // 根→叶，仅当前分支
	} catch {
		return [];
	}
	const out: string[] = [];
	for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
		const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (e.type !== "message" || e.message?.role !== "user") continue;
		const c = e.message.content;
		if (typeof c === "string") out.push(c);
		else if (Array.isArray(c)) out.push(c.map((p) => (p?.type === "text" ? p.text : "")).join("\n"));
	}
	return out.reverse();
}

function isCodeTask(prompt: string, session: { getBranch(): unknown[] }): boolean {
	if (TRIGGER_RE.test(prompt)) return true;
	if (DOC_RE.test(prompt)) return false; // 文档写作任务：明确不纳入
	const codeCur = CODE_RE.test(prompt);
	if (NON_CODE_RE.test(prompt) && !codeCur) return false;
	if (codeCur) return true;
	// 无信号（如“继续”“好的”）：回看历史，承接多轮编码会话
	return recentUserTexts(session)
		.filter((t) => t !== prompt)
		.some((t) => CODE_RE.test(t));
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isCodeTask(event.prompt ?? "", ctx.sessionManager)) return;
		let skill: string;
		try {
			skill = readFileSync(SKILL_PATH, "utf-8");
		} catch {
			// skill 不存在或被移动时静默跳过，不干扰正常流程
			return;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n<ponytail_skill_injected>\n${skill}\n</ponytail_skill_injected>`,
		};
	});
}

// 自检：npx tsx ponytail-always.ts --selfcheck
if (process.argv.includes("--selfcheck")) {
	const cases: Array<[string, string[], boolean]> = [
		["帮我写个测试", [], true], // 代码信号
		["这段代码有 bug，帮我修复", [], true],
		["review 一下这个 PR 的分支合并", [], true],
		["选哪个日志库/依赖比较好", [], true],
		["ponytail", [], true], // 显式触发
		["把这个翻译成英文", [], false], // 非代码
		["帮我写一首诗", [], false],
		["写一份简历", [], false],
		["继续", ["帮我写一个 Python 脚本"], true], // 历史承接
		["继续", ["推荐一本书"], false],
		["写一个菜谱 app", [], true], // 非代码+代码并存 → 代码优先
		["帮我写一个 Python 脚本", [], true], // 代码信号
		["帮我写 PRD 文档", [], false], // 文档写作：不纳入
		["现在写 SDD", ["帮我写一个 Python 脚本"], false], // 文档任务堵住历史承接
		["写 SDD，讨论微服务架构", [], false], // 文档任务优先于代码词
		["ponytail，帮我写 SDD", [], true], // 显式触发词仍生效
		["Python 的 GIL 是什么", [], true], // 已知误报：知识问答
	];
	let fail = 0;
	for (const [prompt, history, want] of cases) {
		const got = isCodeTask(prompt, {
			getBranch: () =>
				history.map((t) => ({ type: "message", message: { role: "user", content: t } })),
		});
		if (got !== want) {
			fail++;
			console.error(`FAIL: ${JSON.stringify(prompt)} want=${want} got=${got}`);
		}
	}
	console.log(fail === 0 ? "selfcheck OK" : `selfcheck FAILED (${fail})`);
	process.exit(fail === 0 ? 0 : 1);
}
