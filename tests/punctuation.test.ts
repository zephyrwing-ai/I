import { test } from "node:test";
import assert from "node:assert/strict";
import { containsCJK, normalizePunctuation } from "../frontend/src/utils/punctuation";

/** 幂等校验：规范化两次与一次结果一致。 */
function expectIdempotent(input: string, expected: string): void {
  assert.equal(normalizePunctuation(input), expected);
  assert.equal(normalizePunctuation(expected), expected);
}

test("containsCJK: 汉字判定", () => {
  assert.equal(containsCJK("hello"), false);
  assert.equal(containsCJK("3.14"), false);
  assert.equal(containsCJK("你好"), true);
  assert.equal(containsCJK("中文 hello 混排"), true);
  assert.equal(containsCJK(""), false);
});

test("全角标点转半角", () => {
  expectIdempotent("你好，世界。", "你好, 世界.");
  expectIdempotent("先，然后；最后！", "先, 然后; 最后!");
  expectIdempotent("真的吗？", "真的吗?");
  expectIdempotent("他说：“你好”；为什么？", "他说: \"你好\"; 为什么?");
});

test("顿号、括号、引号、波浪、百分号", () => {
  expectIdempotent("苹果、香蕉、梨。", "苹果, 香蕉, 梨.");
  expectIdempotent("（括号）【方括号】", "(括号)[方括号]");
  expectIdempotent("约40%～50%。", "约40%~50%.");
});

test("纯英文原样返回", () => {
  const inputs = [
    "Hello,world. This is 3.14!",
    "README：setup",
    "`const value = 'fullwidth，punctuation'`",
  ];
  for (const input of inputs) assert.equal(normalizePunctuation(input), input);
});

test("数字保护：3.14 / 1.2.3 不加空格", () => {
  expectIdempotent("圆周率约3.14。", "圆周率约3.14.");
  expectIdempotent("版本是1.2.3。", "版本是1.2.3.");
  expectIdempotent("温度23°C，湿度40%。", "温度23°C, 湿度40%.");
});

test("文件名与域名保护：package.json / goo.gl 不加空格", () => {
  expectIdempotent("看看package.json文件。", "看看package.json文件.");
  expectIdempotent("访问goo.gl链接。", "访问goo.gl链接.");
});

test("URL 保护：https:// 后面不加空格", () => {
  expectIdempotent("看 https://example.com。", "看 https://example.com.");
});

test("时间保护：10:30 不加空格", () => {
  expectIdempotent("10:30 开始。", "10:30 开始.");
});

test("已带空格时不重复补", () => {
  expectIdempotent("好的， 没问题。", "好的, 没问题.");
});

test("中英混排：补空格位置正确", () => {
  expectIdempotent("hello，世界。", "hello, 世界.");
  expectIdempotent("好的, 然后。 接下来。", "好的, 然后. 接下来.");
});

test("代码块整体跳过", () => {
  const input = "```py\nprint(\"你好，世界\")\n```\n完了。";
  expectIdempotent(input, "```py\nprint(\"你好，世界\")\n```\n完了.");
});

test("用户消息中的行内代码不属于围栏豁免范围", () => {
  const output = normalizePunctuation("说明：`你好，世界。`");
  assert.ok(output.includes("`你好, 世界."));
  assert.doesNotMatch(output, /[，。]/);
  assert.equal(normalizePunctuation(output), output);
});

test("未闭合代码块至文末，跳过", () => {
  expectIdempotent("```\n乱，写。", "```\n乱，写。");
});

test("英文代码块不含汉字直接跳过（预处理短路）", () => {
  const code = "```\nconsole.log(1, 2)\n```";
  assert.equal(normalizePunctuation(code), code);
});
